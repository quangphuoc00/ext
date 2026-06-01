/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // contracts ships TypeScript source; let Next transpile it.
  transpilePackages: ["@optionpilot/contracts"],
};

export default nextConfig;
