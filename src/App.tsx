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

export default function App() {
  if (!isSupabaseConfigured) return <SetupScreen missing={missingEnvVars} />
  return (
    <BrowserRouter>
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
    </BrowserRouter>
  )
}
