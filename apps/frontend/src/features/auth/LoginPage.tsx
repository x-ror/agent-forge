import { Button, Column, Form, Grid, InlineNotification, Stack, TextInput, Tile, Toggle } from '@carbon/react';
import { useState } from 'react';
import { useLogin } from '../../api/hooks';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [register, setRegister] = useState(false);
  const login = useLogin();

  return (
    <Grid className="af-login">
      <Column sm={4} md={4} lg={{ span: 6, offset: 5 }}>
        <Tile className="af-login__tile">
          <Form
            aria-label="login form"
            onSubmit={(e) => {
              e.preventDefault();
              login.mutate({ email, password, register });
            }}
          >
            <Stack gap={6}>
              <h2>AgentForge</h2>
              <p>Local-first orchestration for autonomous coding agents.</p>
              {login.isError && <InlineNotification kind="error" title="Sign-in failed" subtitle={login.error.message} lowContrast hideCloseButton />}
              <TextInput id="email" labelText="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <TextInput id="password" labelText="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <Toggle
                id="register-toggle"
                size="sm"
                labelText="Create a new account"
                labelA="No"
                labelB="Yes"
                toggled={register}
                onToggle={(checked: boolean) => setRegister(checked)}
              />
              <Button type="submit" disabled={login.isPending}>
                {register ? 'Register' : 'Log in'}
              </Button>
            </Stack>
          </Form>
        </Tile>
      </Column>
    </Grid>
  );
}
