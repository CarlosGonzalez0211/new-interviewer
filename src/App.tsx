import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import AuthProvider from './auth/AuthProvider'
import ProtectedRoute from './auth/ProtectedRoute'
import Layout from './components/Layout'
import SetupScreen from './components/SetupScreen'
import { isSupabaseConfigured, missingEnvVars } from './lib/supabase'
import Dashboard from './pages/Dashboard'
import Home from './pages/Home'
import Login from './pages/Login'
import NotFound from './pages/NotFound'
import QuestionPage from './pages/QuestionPage'
import RoomPage from './pages/RoomPage'
import Spinner from './components/ui/Spinner'

// Demo mode with an in-memory backend. Lazy so none of the fake backend lands in the main bundle.
const SandboxPage = lazy(() => import('./sandbox/SandboxPage'))

function MainApp() {
  if (!isSupabaseConfigured) return <SetupScreen missing={missingEnvVars} />
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<Layout />}>
          <Route path="/" element={<Home />} />
          <Route path="/questions/:slug" element={<QuestionPage />} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/session/:id"
            element={
              <ProtectedRoute>
                <RoomPage />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </AuthProvider>
  )
}

const isSandboxPath = (pathname: string) => /^\/sandbox(\/|$)/.test(pathname)

/** In-app navigation to /sandbox: the sandbox owns its routers, so hand over with a full page load. */
function HardReload() {
  useEffect(() => {
    window.location.reload()
  }, [])
  return null
}

export default function App() {
  // Public, no login and no Supabase config needed: the sandbox runs on its own fake backend. It renders its own
  // MemoryRouters (one per pane), so it must live outside the BrowserRouter (routers cannot nest).
  if (isSandboxPath(window.location.pathname)) {
    return (
      <Suspense
        fallback={
          <div className="center-screen">
            <Spinner label="Loading sandbox" />
          </div>
        }
      >
        <SandboxPage />
      </Suspense>
    )
  }
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/sandbox/*" element={<HardReload />} />
        <Route path="*" element={<MainApp />} />
      </Routes>
    </BrowserRouter>
  )
}
