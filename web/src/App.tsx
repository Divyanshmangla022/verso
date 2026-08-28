import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';

// The editor bundles TipTap/ProseMirror - split it so login/dashboard stay light.
const EditorPage = lazy(() => import('./pages/EditorPage').then((m) => ({ default: m.EditorPage })));

function Loading() {
  return (
    <div className="page-center">
      <div className="spinner" aria-label="Loading" />
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
