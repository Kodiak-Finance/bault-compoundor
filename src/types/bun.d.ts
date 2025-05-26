// Type declarations for Bun runtime
declare namespace Bun {
  /**
   * Environment variables from process.env and .env files
   */
  export const env: {
    [key: string]: string | undefined;
  };
}