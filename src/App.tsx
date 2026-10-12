import { BrowserRouter, Route, Routes } from 'react-router-dom'
import AuthProvider from './auth/AuthProvider'
import ProtectedRoute from './auth/ProtectedRoute'
import Layout from './components/Layout'
import SetupScreen from './components/SetupScreen'
import { isSupabaseConfigured, missingEnvVars } from './lib/supabase'
import Dashboard from './pages/Dashboard'
import Login from './pages/Login'
import NewSession from './pages/NewSession'
import NotFound from './pages/NotFound'
import RoomPage from './pages/RoomPage'

export default function App() {
  if (!isSupabaseConfigured) return <SetupScreen missing={missingEnvVars} />
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route path="/" element={<Dashboard />} />
            <Route path="/new" element={<NewSession />} />
            <Route path="/session/:id" element={<RoomPage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
