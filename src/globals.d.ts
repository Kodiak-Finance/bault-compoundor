declare global {
  var Bun: {
    env: Record<string, string | undefined>;
  } | undefined;
}

export {}; 