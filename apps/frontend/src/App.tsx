import { Content, Header, HeaderMenuButton, HeaderName, SideNav, SideNavItems, SideNavLink, Theme } from '@carbon/react';
import { useState } from 'react';

export default function App() {
  const [sideNavExpanded, setSideNavExpanded] = useState(true);

  return (
    <Theme theme="g100">
      <Header aria-label="AgentForge">
        <HeaderMenuButton aria-label={sideNavExpanded ? 'Close menu' : 'Open menu'} onClick={() => setSideNavExpanded(!sideNavExpanded)} isActive={sideNavExpanded} />
        <HeaderName href="/" prefix="">
          AgentForge
        </HeaderName>
      </Header>
      <SideNav aria-label="Side navigation" expanded={sideNavExpanded} isPersistent>
        <SideNavItems>
          <SideNavLink href="/">Task Board</SideNavLink>
          <SideNavLink href="/workflows">Workflows</SideNavLink>
          <SideNavLink href="/flow-runs">Flow Runs</SideNavLink>
          <SideNavLink href="/settings">Settings</SideNavLink>
        </SideNavItems>
      </SideNav>
      <Content>
        <h1>AgentForge</h1>
        <p>Orchestrate autonomous coding agents — local-first.</p>
      </Content>
    </Theme>
  );
}
