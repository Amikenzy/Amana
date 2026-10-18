/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['./jest.setup.ts'],
  testMatch: ['**/__tests__/**/*.test.{ts,tsx}', '**/e2e/**/*.e2e.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  transformIgnorePatterns: [
    '^(?!.*\\.pnpm[/\\\\](?:expo[^/\\\\]*@[^/\\\\]+|@expo\\+[^/\\\\]+|@react-native\\+[^/\\\\]+|@react-native-community\\+[^/\\\\]+|react-native-gesture-handle[^/\\\\]*|react-native[^/\\\\]*@[^/\\\\]+)[/\\\\]node_modules[/\\\\]).*node_modules[/\\\\](?!((jest-)?react-native|@react-native[/\\\\].*|@react-native-community[/\\\\].*|expo(nent)?|@expo(nent)?[/\\\\].*|@expo-google-fonts[/\\\\].*|react-navigation|@react-navigation[/\\\\].*|@unimodules[/\\\\].*|unimodules|sentry-expo|native-base|react-native-svg|zustand)[/\\\\])',
  ],
};
