#!/usr/bin/env node
import { main } from './main.js';
import { describeError, isDebug, writeLine } from './report.js';

// Set the exit code and let the event loop drain: process.exit() could truncate stderr on a pipe.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    writeLine(describeError(error, isDebug(process.env)));
    process.exitCode = 1;
  },
);
