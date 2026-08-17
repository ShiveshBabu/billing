/**
 * Validates required environment variables at startup. This is deliberately
 * run BEFORE anything else (database connection, server listen, etc.) so a
 * misconfigured deployment fails immediately with a clear message — not an
 * obscure crash five requests later when something finally touches the
 * missing config.
 */
interface EnvRule {
  name: string;
  required: boolean | ((env: NodeJS.ProcessEnv) => boolean);
  validate?: (value: string) => string | null; // returns an error message, or null if valid
  hint: string;
}

const RULES: EnvRule[] = [
  {
    name: 'DATABASE_URL',
    required: true,
    validate: (v) => (v.startsWith('postgres://') || v.startsWith('postgresql://') ? null : 'must be a postgres:// or postgresql:// connection string'),
    hint: 'Set this to your PostgreSQL connection string. On Railway, reference the Postgres plugin\'s DATABASE_URL variable.'
  },
  {
    name: 'SESSION_SECRET',
    required: true,
    validate: (v) => {
      if (v.includes('CHANGE_ME') || v.length < 32) return 'must be a real random secret at least 32 characters long, not the placeholder value';
      return null;
    },
    hint: 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  },
  {
    name: 'NODE_ENV',
    required: false,
    hint: 'Should be "production" on Railway/production deployments, "development" locally.'
  },
  {
    name: 'CORS_ORIGIN',
    // Only strictly required when NOT serving the frontend from this same
    // process (i.e. a separate frontend deployment) — see server.ts SAME_ORIGIN.
    required: (env) => env.SERVE_FRONTEND !== 'true',
    hint: 'Set to the exact origin of your separately-deployed frontend (e.g. https://your-frontend.up.railway.app). Not needed if SERVE_FRONTEND=true.'
  }
];

export function validateEnv(): void {
  const errors: string[] = [];
  for (const rule of RULES) {
    const required = typeof rule.required === 'function' ? rule.required(process.env) : rule.required;
    const value = process.env[rule.name];
    if (!value) {
      if (required) errors.push(`Missing required environment variable ${rule.name}.\n    → ${rule.hint}`);
      continue;
    }
    if (rule.validate) {
      const err = rule.validate(value);
      if (err) errors.push(`Invalid ${rule.name}: ${err}.\n    → ${rule.hint}`);
    }
  }

  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error('\n=== STARTUP FAILED: environment configuration problem ===\n');
    for (const e of errors) console.error(' ✗ ' + e + '\n');
    console.error('See .env.example and DEPLOYMENT.md for the full list of required variables.\n');
    process.exit(1);
  }
}
