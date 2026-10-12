import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    // Node by default; component tests opt into jsdom via `// @vitest-environment jsdom`.
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'supabase/functions/**/*.test.ts', 'supabase/tests/**/*.test.ts'],
  },
})
