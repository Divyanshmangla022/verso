import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';

// The editor bundles TipTap/ProseMirror - split it so login/dashboard stay light.
const EditorPage = lazy(() => import('./pages/EditorPage').then((m) => ({ default: m.EditorPage })));

/** How long to wait before admitting that this is a cold start, not a hang. */
const COLD_START_HINT_MS = 3_000;

function Loading() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), COLD_START_HINT_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="page-center" style={{ flexDirection: 'column', gap: 14 }}>
      <div className="spinner" aria-label="Loading" />
      {slow && (
        // The demo runs on a free instance that sleeps when idle; the first
        // request after that takes up to a minute to wake it.
        <p className="muted" style={{ margin: 0, maxWidth: 320, textAlign: 'center' }} role="status">
          Waking the server - the free demo instance sleeps when idle, so the first load can take up to a minute.
        </p>
      )}
    </div>
  );
}

function Protected({ children }: { children: React.ReactElement }) {
  const { user, loading, offline, retry } = useAuth();
  const location = useLocation();
  if (loading) return <Loading />;
  if (offline && !user) {
    // A stored session exists but the server is unreachable (restart, network
    // blip): keep the session and offer a retry instead of bouncing to login.
    return (
      <div className="page-center" style={{ flexDirection: 'column', gap: 14 }}>
        <p className="error-text" style={{ fontSize: 15, margin: 0 }}>
          Cannot reach the server. Your session is safe - it may be restarting.
        </p>
        <button className="btn primary" onClick={retry}>
          Try again
        </button>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/"
              element={
                <Protected>
                  <DashboardPage />
                </Protected>
              }
            />
            <Route
              path="/doc/:id"
              element={
                <Protected>
                  <EditorPage />
                </Protected>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
  );
}
