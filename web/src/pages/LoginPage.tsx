import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';

const DEMO_ACCOUNTS = [
  { email: 'ada@demo.verso.app', label: 'Sign in as Ada (owns shared docs)' },
  { email: 'grace@demo.verso.app', label: 'Sign in as Grace (has shared access)' },
];
const DEMO_PASSWORD = 'VersoDemo1!';

export function LoginPage() {
  const { user, login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, name, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const demoLogin = async (demoEmail: string) => {
    setError('');
    setBusy(true);
    try {
      await login(demoEmail, DEMO_PASSWORD);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Demo login failed - has the database been seeded?');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="brand">
          <span className="brand-mark">V</span> Verso
        </div>
        <h1>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
        <p className="sub">A lightweight collaborative document editor with an AI writing layer.</p>

        <div className="login-tabs" role="tablist">
          <button role="tab" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
            Sign in
          </button>
          <button role="tab" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
            Register
          </button>
        </div>

        <form onSubmit={submit}>
          {mode === 'register' && (
            <label className="field">
              Name
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="Ada Lovelace" />
            </label>
          )}
          <label className="field">
            Email
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@example.com" autoComplete="username" />
          </label>
          <label className="field">
            Password
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === 'register' ? 8 : 1}
              placeholder={mode === 'register' ? 'At least 8 characters' : 'Your password'}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            />
          </label>
          {error && <p className="error-text">{error}</p>}
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} disabled={busy}>
            {busy ? 'Please wait...' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <div className="demo-box">
          <p>Demo accounts</p>
          {DEMO_ACCOUNTS.map((d) => (
            <button key={d.email} className="btn" onClick={() => demoLogin(d.email)} disabled={busy}>
              {d.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
