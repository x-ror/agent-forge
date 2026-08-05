import { describe, expect, it } from 'vitest';
import { mergeRequestNewUrl, remoteWebUrl } from './scm';

describe('remoteWebUrl', () => {
  it('converts ssh and https remotes to web URLs', () => {
    expect(remoteWebUrl('git@gitlab.devandgo.com:main/proxycrawl.git')).toBe('https://gitlab.devandgo.com/main/proxycrawl');
    expect(remoteWebUrl('ssh://git@gitlab.co.com/grp/sub/app.git')).toBe('https://gitlab.co.com/grp/sub/app');
    expect(remoteWebUrl('https://gitlab.co.com/grp/app.git')).toBe('https://gitlab.co.com/grp/app');
    expect(remoteWebUrl('https://gitlab.co.com/grp/app/')).toBe('https://gitlab.co.com/grp/app');
    expect(remoteWebUrl('file:///home/me/repo')).toBeNull();
  });
});

describe('mergeRequestNewUrl', () => {
  it('builds the create-MR page with the source branch preselected', () => {
    expect(mergeRequestNewUrl('git@gitlab.devandgo.com:main/proxycrawl.git', 'agentforge/x-ror/pc-1')).toBe(
      'https://gitlab.devandgo.com/main/proxycrawl/-/merge_requests/new?merge_request%5Bsource_branch%5D=agentforge%2Fx-ror%2Fpc-1',
    );
    expect(mergeRequestNewUrl('file:///home/me/repo', 'b')).toBeNull();
  });
});
