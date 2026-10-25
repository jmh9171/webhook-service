import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ArrowRight, Check, Eye, EyeOff, Loader2, LockKeyhole, Webhook } from 'lucide-react';
import { identify, resetIdentity, track } from './lib/analytics';

interface Session { authenticated: boolean; username: string | null; userId: string | null; loginRequired: boolean }

export function SessionGate({ children }: { children: (username: string, signOut: () => Promise<void>, loginRequired: boolean) => ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const authRevision = useRef(0);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const revision = ++authRevision.current;
    try {
      const response = await fetch('/api/auth/session', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      const next: Session = await response.json();
      if (revision !== authRevision.current) return;
      if (next.authenticated && next.userId) identify(next.userId);
      else resetIdentity();
      setSession(next); setError('');
    } catch { if (revision === authRevision.current) setError('Couldn’t reach your inbox. Please try again.'); }
  }, []);
  useEffect(() => { void load(); const expired = () => { authRevision.current++; resetIdentity(); setSession({ authenticated: false, username: null, userId: null, loginRequired: true }); }; window.addEventListener('inbox:unauthorized', expired); return () => { authRevision.current++; window.removeEventListener('inbox:unauthorized', expired); }; }, [load]);

  async function signOut() {
    const response = await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Inbox-Action': 'logout' } });
    if (!response.ok && response.status !== 401) throw new Error('Couldn’t sign out. Please try again.');
    authRevision.current++;
    resetIdentity();
    setSession({ authenticated: false, username: null, userId: null, loginRequired: true });
  }

  if (!session) return <div className="auth-loading"><Webhook size={30} /><p>{error || 'Opening your inbox…'}</p>{error ? <button className="button dark" onClick={() => void load()}>Try again<ArrowRight size={15} /></button> : <Loader2 size={18} className="spin" />}</div>;
  if (!session.authenticated) return <Login onSignedIn={() => void load()} />;
  return children(session.username ?? 'owner', signOut, session.loginRequired);
}

function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const viewed = useRef(false);
  useEffect(() => {
    if (viewed.current) return;
    viewed.current = true;
    track('page_viewed', { path: '/login' });
  }, []);
  const [username, setUsername] = useState('owner');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError('');
    try {
      const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Inbox-Action': 'login' }, body: JSON.stringify({ username, password }) });
      if (!response.ok) {
        setError(response.status === 401 ? 'Those details didn’t match. Please try again.' : response.status === 429 ? 'Too many attempts. Wait a minute and try again.' : 'Couldn’t sign in. Please try again.');
        return;
      }
      setPassword(''); onSignedIn();
    } catch { setError('Couldn’t reach your inbox. Check your connection and try again.'); }
    finally { setPending(false); }
  }

  return <div className="login-page">
    <section className="login-story" aria-label="Webhook Inbox">
      <a className="login-brand" href="/"><span className="login-mark"><Webhook size={25} /></span><span>webhook<br /><b>lab</b></span></a>
      <div className="login-story-content"><div className="eyebrow">A WORKSPACE FOR YOUR WEBHOOKS</div><div className="login-statement">Catch.<br /> Inspect.<br /> <span>Replay.</span><i>↗</i></div><p>From an incoming request<br /> to your next local test.</p></div>
      <div className="login-flow" aria-hidden="true"><span><small>01</small>CAPTURE</span><i /><span><small>02</small>INSPECT</span><i /><span><small>03</small>REPLAY</span></div>
      <div className="login-story-footer"><span className="tiny-dot" />PERSONAL TOOLS, LESS FRICTION.</div>
    </section>
    <section className="login-access">
      <div className="login-top-note"><LockKeyhole size={13} /> PRIVATE WORKSPACE</div>
      <div className="login-form-wrap"><div className="login-form-index"><span>01 / SIGN IN</span><span>↙</span></div><h1>Welcome<br /> back<span>_</span></h1><p className="login-description">Your requests. Your workspace.<br /> Sign in to pick up where you left off.</p>
        <form onSubmit={submit}>
          <label className="field-label" htmlFor="username">USERNAME</label><input className="login-input" id="username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required value={username} onChange={(event) => setUsername(event.target.value)} disabled={pending} aria-invalid={!!error} aria-describedby={error ? 'login-error' : undefined} />
          <label className="field-label" htmlFor="password">PASSWORD</label><div className="password-field"><input className="login-input" id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} disabled={pending} aria-invalid={!!error} aria-describedby={error ? 'login-error' : undefined} /><button type="button" className="icon-button" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
          {error && <p id="login-error" className="login-error" role="alert">{error}</p>}
          <button className="login-submit" type="submit" disabled={pending}>{pending ? <><Loader2 size={17} className="spin" />Signing in…</> : <>Open your workspace<ArrowRight size={18} /></>}</button>
        </form>
        <div className="login-reassurance"><Check size={14} /><span>Your local replay URL stays saved in this browser.</span></div>
      </div>
      <footer className="login-access-footer"><span>WEBHOOK LAB / PERSONAL EDITION</span><span>CAPTURE → LOCALHOST</span></footer>
    </section>
  </div>;
}
