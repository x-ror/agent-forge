import { ContentSwitcher, Switch, TreeView, TreeNode } from '@carbon/react';
import { DiffModeEnum, DiffView as GitDiffView } from '@git-diff-view/react';
import '@git-diff-view/react/styles/diff-view.css';
import { useMemo, useState } from 'react';
import { useAppState } from '../../state/app-state';

interface DiffFileSection {
  path: string;
  lang: string;
  /** The file's complete unified diff section, headers included. */
  hunks: string;
  additions: number;
  deletions: number;
}

/** Splits a multi-file unified git diff into per-file sections. */
export function splitDiff(diff: string): DiffFileSection[] {
  const sections: DiffFileSection[] = [];
  // Split on file boundaries; a diff without `diff --git` headers is one section.
  const parts = diff.split(/^diff --git /m).filter((part) => part.trim().length > 0);
  for (const part of parts) {
    const pathMatch = /^\+\+\+ (?:b\/)?(.+)$/m.exec(part) ?? /^--- (?:a\/)?(.+)$/m.exec(part);
    const path = pathMatch?.[1]?.trim() ?? '(unknown)';
    const hunkStart = part.indexOf('@@');
    if (hunkStart < 0) continue;
    let additions = 0;
    let deletions = 0;
    for (const line of part.slice(hunkStart).split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
    }
    sections.push({
      path,
      lang: path.split('.').at(-1) ?? 'txt',
      // The parser needs the full per-file diff (diff --git/---/+++ headers
      // included) — hunk-only input parses to an empty view.
      hunks: `diff --git ${part}`,
      additions,
      deletions,
    });
  }
  return sections;
}

export function DiffView({ diff }: { diff: string }) {
  const { theme } = useAppState();
  const files = useMemo(() => splitDiff(diff), [diff]);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<DiffModeEnum>(DiffModeEnum.Unified);
  const visible = selected ? files.filter((f) => f.path === selected) : files;

  if (files.length === 0) return <p>No changes.</p>;

  return (
    <div className="af-diff">
      <div className="af-diff__tree">
        <ContentSwitcher size="sm" selectedIndex={mode === DiffModeEnum.Unified ? 0 : 1} onChange={({ index }) => setMode(index === 0 ? DiffModeEnum.Unified : DiffModeEnum.Split)}>
          <Switch name="unified" text="Unified" />
          <Switch name="split" text="Side-by-side" />
        </ContentSwitcher>
        <TreeView label="Changed files" hideLabel size="xs">
          <TreeNode id="all" label={`All files (${files.length})`} onSelect={() => setSelected(null)} isExpanded>
            {files.map((file) => (
              <TreeNode key={file.path} id={file.path} label={`${file.path} (+${file.additions}/-${file.deletions})`} onSelect={() => setSelected(file.path)} />
            ))}
          </TreeNode>
        </TreeView>
      </div>
      <div className="af-diff__files">
        {visible.map((file) => (
          <div key={file.path} className="af-diff__file" data-testid={`diff-file-${file.path}`}>
            <h5 className="af-diff__file-header">
              {file.path} <span className="af-diff__additions">+{file.additions}</span> <span className="af-diff__deletions">-{file.deletions}</span>
            </h5>
            <GitDiffView
              data={{
                oldFile: { fileName: file.path, fileLang: file.lang },
                newFile: { fileName: file.path, fileLang: file.lang },
                hunks: [file.hunks],
              }}
              diffViewMode={mode}
              diffViewTheme={theme === 'g100' ? 'dark' : 'light'}
              diffViewHighlight={false}
              diffViewWrap
              diffViewFontSize={12}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
