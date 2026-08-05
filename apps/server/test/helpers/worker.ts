import { Queue, Worker } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { AdapterRegistry } from '../../src/contexts/agent-registry/application/adapter-registry';
import { TypeormAgentRepository } from '../../src/contexts/agent-registry/infrastructure/typeorm-repositories';
import { RunOrchestrator } from '../../src/contexts/execution/application/run-orchestrator';
import { RunTxOps } from '../../src/contexts/execution/infrastructure/run-tx-ops';
import { TypeormRunEventRepository, TypeormRunInputRepository, TypeormRunRepository } from '../../src/contexts/execution/infrastructure/typeorm-repositories';
import { ProcessSandboxDriver } from '../../src/contexts/execution/infrastructure/sandbox/process-driver';
import { SecretProvisioningService } from '../../src/contexts/projects/application/projects.service';
import { SecretBox, type SecretBoxService } from '../../src/shared/crypto/secret-box';
import { TypeormProjectRepository, TypeormSecretRepository } from '../../src/contexts/projects/infrastructure/typeorm-repositories';
import { loadEnv, type AppEnv } from '../../src/config/env';
import { UnitOfWork } from '../../src/database/unit-of-work';
import { OutboxDispatcher } from '../../src/shared/outbox/outbox-dispatcher.service';
import { OutboxWriter } from '../../src/shared/outbox/outbox.writer';
import { QUEUE_CONFIG, QUEUE_NAMES, type QueueName } from '../../src/shared/queue/queues';
import type { QueueMap } from '../../src/shared/queue/queue.module';
import { ReconciliationService } from '../../src/worker/reconciliation.service';
import { ScmService } from '../../src/contexts/scm/application/scm.service';
import { FlowEngine } from '../../src/contexts/orchestration/application/flow-engine.service';
import { OrchestrationTxOps } from '../../src/contexts/orchestration/infrastructure/orchestration-tx';
import { LocalShellAdapter } from '../../src/contexts/orchestration/infrastructure/shell.adapter';
import { GitCli } from '../../src/contexts/scm/infrastructure/git-cli';
import { GithubClient } from '../../src/contexts/scm/infrastructure/github-client';
import { TypeormArtifactRepository } from '../../src/contexts/execution/infrastructure/typeorm-repositories';

export interface TestWorker {
  registry: AdapterRegistry;
  orchestrator: RunOrchestrator;
  scm: ScmService;
  flowEngine: FlowEngine;
  dispatcher: OutboxDispatcher;
  reconciliation: ReconciliationService;
  queues: QueueMap;
  runRepo: TypeormRunRepository;
  eventRepo: TypeormRunEventRepository;
  stop(): Promise<void>;
}

/** Assembles the worker side (orchestrator + dispatcher + BullMQ consumer) for e2e tests. */
export function buildTestWorker(ds: DataSource, redisUrl: string, redisClient: Redis, envOverrides: Partial<AppEnv> = {}): TestWorker {
  const env: AppEnv = { ...loadEnv(), ...envOverrides };

  const queues = {} as Record<QueueName, Queue>;
  for (const name of QUEUE_NAMES) {
    queues[name] = new Queue(name, {
      connection: redisClient,
      defaultJobOptions: QUEUE_CONFIG[name].defaultJobOptions,
    });
  }
  const queueMap = queues as QueueMap;

  const registry = new AdapterRegistry();
  const uow = new UnitOfWork(ds);
  const outboxWriter = new OutboxWriter();
  const txOps = new RunTxOps(uow, outboxWriter);
  const secretBox = new SecretBox(env.AGENTFORGE_SECRET_KEY) as SecretBoxService;
  const secretProvisioning = new SecretProvisioningService(new TypeormSecretRepository(ds), secretBox);

  const scm = new ScmService(env, new TypeormArtifactRepository(ds), new GitCli(), new GithubClient(), new TypeormProjectRepository(ds), secretProvisioning);

  const orchestrator = new RunOrchestrator(
    new TypeormRunRepository(ds),
    new TypeormRunInputRepository(ds),
    new TypeormAgentRepository(ds),
    new TypeormProjectRepository(ds),
    new ProcessSandboxDriver(),
    env,
    registry,
    secretProvisioning,
    scm,
    txOps,
  );

  const dispatcher = new OutboxDispatcher(ds, redisClient, queueMap);
  const reconciliation = new ReconciliationService(ds, queueMap);
  const flowEngine = new FlowEngine(new OrchestrationTxOps(uow, outboxWriter), new LocalShellAdapter(), scm);

  const bullWorker = new Worker(
    'run.execute',
    async (job) => {
      await orchestrator.execute((job.data as { runId: string }).runId);
    },
    {
      connection: new IORedis(redisUrl, { maxRetriesPerRequest: null }),
      concurrency: 3,
    },
  );
  const flowWorker = new Worker(
    'flow.advance',
    async (job) => {
      await flowEngine.tick((job.data as { flowRunId: string }).flowRunId);
    },
    {
      connection: new IORedis(redisUrl, { maxRetriesPerRequest: null }),
      concurrency: 5,
    },
  );

  return {
    registry,
    orchestrator,
    scm,
    flowEngine,
    dispatcher,
    reconciliation,
    queues: queueMap,
    runRepo: new TypeormRunRepository(ds),
    eventRepo: new TypeormRunEventRepository(ds),
    stop: async () => {
      dispatcher.stop();
      await bullWorker.close(true);
      await flowWorker.close(true);
      await Promise.all(Object.values(queueMap).map((q) => q.close()));
    },
  };
}
