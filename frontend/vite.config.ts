import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Split heavy, rarely-changing vendor code into stable chunks. They are
        // cached across app deploys (only app code re-downloads on update) and
        // load in parallel instead of one giant blocking bundle.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          ethers: ['ethers'],
          wallet: ['wagmi', 'viem', '@rainbow-me/rainbowkit', '@tanstack/react-query'],
        },
      },
    },
  },
});
