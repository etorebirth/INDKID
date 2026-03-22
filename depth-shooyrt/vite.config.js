import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// <REPO_NAME> をあなたのリポジトリ名に合わせてください
export default defineConfig({
  plugins: [react()],
  base: '/INDKID/', // ユーザーページ直下の場合は '/' に
})