/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * RocketRide Client TypeScript SDK
 *
 * Main entry point for the RocketRide TypeScript client library.
 * Exports all public APIs, types, exceptions, and schema definitions.
 *
 * @packageDocumentation
 */

// Export all exceptions
export * from './exceptions/index.js';

// Export all schema classes
export * from './schema/index.js';

// Export all type definitions
export * from './types/index.js';

// Export constants
export * from './constants.js';

// Export the main client and utilities
export * from './client.js';

// Export the database API namespace (DatabaseApi class, DatabaseDialect enum)
export * from './database.js';

// Sequelize factory and related types (frozen SDK contract surface — deprecated
// in favor of `rocketride/drizzle`, retained until a coordinated major release)
export { createSequelize } from './database/sequelize/create-sequelize.js';
export type { CreateSequelizeOptions, SequelizeConstructor } from './database/sequelize/create-sequelize.js';

// Export the run-log DVR session class (the codec stays internal — only the
// session and its user-facing types are public surface)
export { LogEventStream } from './log-stream.js';
