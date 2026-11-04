import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import './styles/App.css'
import './styles/testing.css'
import './styles/requirements.css'
import './styles/auth.css'
import './styles/layout.css'
import { BrowserRouter } from 'react-router-dom'
import AppRouter from './app/AppRouter.tsx'
import { AuthProvider } from './features/auth/Auth.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter><AuthProvider><AppRouter /></AuthProvider></BrowserRouter>
  </StrictMode>,
)
