// A fixed API route is more portable across serverless providers than a
// framework-specific dynamic filename. The shared handler reads ?id= first.
export { default } from './audio/[id].mjs';
