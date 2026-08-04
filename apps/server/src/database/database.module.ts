import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { type DataSource } from 'typeorm';
import { APP_ENV, type AppEnv } from '../config/env';
import { createAppDataSource } from './data-source';

export const DATA_SOURCE = Symbol('DATA_SOURCE');

@Global()
@Module({
  providers: [
    {
      provide: DATA_SOURCE,
      inject: [APP_ENV],
      useFactory: async (env: AppEnv): Promise<DataSource> => {
        const dataSource = createAppDataSource(env.DATABASE_URL);
        await dataSource.initialize();
        return dataSource;
      },
    },
  ],
  exports: [DATA_SOURCE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }
}
