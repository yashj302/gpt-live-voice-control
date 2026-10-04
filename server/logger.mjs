import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const logPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'logging-gpt.log');
const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

function serialize(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack || ''}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, (key, nestedValue) => {
      if (/authorization|api[_-]?key|token|secret|password/i.test(key)) return '[REDACTED]';
      if (typeof nestedValue === 'string' && nestedValue.length > 20000) return `${nestedValue.slice(0, 20000)}...[TRUNCATED]`;
      return nestedValue;
    });
  } catch {
    return String(value);
  }
}

export function writeLog(level, ...values) {
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${values.map(serialize).join(' ')}\n`;
  fs.appendFileSync(logPath, line, 'utf8');
  originalConsole[level === 'debug' ? 'log' : level]?.(...values);
}

for (const level of ['log', 'info', 'warn', 'error']) {
  console[level] = (...values) => writeLog(level, ...values);
}

export function getLogPath() {
  return logPath;
}

writeLog('info', 'File logging initialized', { logPath });

process.on('uncaughtException', error => writeLog('error', 'Uncaught exception', error));
process.on('unhandledRejection', reason => writeLog('error', 'Unhandled promise rejection', reason));
process.on('exit', code => writeLog('info', 'Process exiting', { code }));
