#!/usr/bin/env node
import { existsSync } from 'fs'
import arg from 'next/dist/compiled/arg/index.js'
import { join } from 'path'
import chalk from 'next/dist/compiled/chalk'

import { CliCommand } from '../lib/commands'
import {
  ESLINT_DEFAULT_DIRS,
  ESLINT_DEFAULT_DIRS_WITH_APP,
} from '../lib/constants'
import { runLintCheck } from '../lib/eslint/runLintCheck'
import { printAndExit } from '../server/lib/utils'
import { Telemetry } from '../telemetry/storage'
import loadConfig from '../server/config'
import { PHASE_PRODUCTION_BUILD } from '../shared/lib/constants'
import { eventLintCheckCompleted } from '../telemetry/events'
import { CompileError } from '../lib/compile-error'
import isError from '../lib/is-error'
import { getProjectDir } from '../lib/get-project-dir'

const eslintOptions = (args: arg.Spec, defaultCacheLocation: string) => ({
  overrideConfigFile: args['--config'] || null,
  extensions: args['--ext'] ?? [
    '.js',
    '.mjs',
    '.cjs',
    '.jsx',
    '.ts',
    '.mts',
    '.cts',
    '.tsx',
  ],
  resolvePluginsRelativeTo: args['--resolve-plugins-relative-to'] || null,
  rulePaths: args['--rulesdir'] ?? [],
  fix: args['--fix'] ?? false,
  fixTypes: args['--fix-type'] ?? null,
  ignorePath: args['--ignore-path'] || null,
  ignore: !Boolean(args['--no-ignore']),
  allowInlineConfig: !Boolean(args['--no-inline-config']),
  reportUnusedDisableDirectives:
    args['--report-unused-disable-directives'] || null,
  cache: !Boolean(args['--no-cache']),
  cacheLocation: args['--cache-location'] || defaultCacheLocation,
  cacheStrategy: args['--cache-strategy'] || 'metadata',
  errorOnUnmatchedPattern: args['--error-on-unmatched-pattern']
    ? Boolean(args['--error-on-unmatched-pattern'])
    : false,
})

const nextLint: CliCommand = async (argv) => {
  const validArgs: arg.Spec = {
    // Types
    '--help': Boolean,
    '--base-dir': String,
    '--dir': [String],
    '--file': [String],
    '--strict': Boolean,

    // Aliases
    '-h': '--help',
    '-b': '--base-dir',
    '-d': '--dir',
  }

  const validEslintArgs: arg.Spec = {
    // Types
    '--config': String,
    '--ext': [String],
    '--resolve-plugins-relative-to': String,
    '--rulesdir': [String],
    '--fix': Boolean,
    '--fix-type': [String],
    '--ignore-path': String,
    '--no-ignore': Boolean,
    '--quiet': Boolean,
    '--max-warnings': Number,
    '--no-inline-config': Boolean,
    '--report-unused-disable-directives': String,
    '--cache': Boolean, // Although cache is enabled by default, this dummy flag still exists to not cause any breaking changes
    '--no-cache': Boolean,
    '--cache-location': String,
    '--cache-strategy': String,
    '--error-on-unmatched-pattern': Boolean,
    '--format': String,
    '--output-file': String,

    // Aliases
    '-c': '--config',
    '-f': '--format',
    '-o': '--output-file',
  }

  let args: arg.Result<arg.Spec>
  try {
    args = arg({ ...validArgs, ...validEslintArgs }, { argv })
  } catch (error) {
    if (isError(error) && error.code === 'ARG_UNKNOWN_OPTION') {
      return printAndExit(error.message, 1)
    }
    throw error
  }
  if (args['--help']) {
    printAndExit(
      `
      Description
        Run ESLint on every file in specified directories.
        If not configured, ESLint will be set up for the first time.

      Usage
        $ next lint <baseDir> [options]

      <baseDir> represents the directory of the Next.js application.
      If no directory is provided, the current directory will be used.

      Options
        Basic configuration:
          -h, --help                     List this help
          -d, --dir Array                Include directory, or directories, to run ESLint - default: 'pages', 'components', and 'lib'
          --file Array                   Include file, or files, to run ESLint
          -c, --config path::String      Use this configuration file, overriding all other config options
          --ext [String]                 Specify JavaScript file extensions - default: .js, .mjs, .cjs, .jsx, .ts, .mts, .cts, .tsx
          --resolve-plugins-relative-to path::String  A folder where plugins should be resolved from, CWD by default

        Initial setup:
          --strict                       Creates an .eslintrc.json file using the Next.js strict configuration (only possible if no .eslintrc.json file is present)

        Specifying rules:
          --rulesdir [path::String]      Use additional rules from this directory

        Fixing problems:
          --fix                          Automatically fix problems
          --fix-type Array               Specify the types of fixes to apply (problem, suggestion, layout)

        Ignoring files:
          --ignore-path path::String     Specify path of ignore file
          --no-ignore                    Disable use of ignore files and patterns

        Handling warnings:
          --quiet                        Report errors only - default: false
          --max-warnings Int             Number of warnings to trigger nonzero exit code - default: -1

        Output:
          -o, --output-file path::String  Specify file to write report to
          -f, --format String            Use a specific output format - default: Next.js custom formatter

        Inline configuration comments:
          --no-inline-config             Prevent comments from changing config or rules
          --report-unused-disable-directives  Adds reported errors for unused eslint-disable directives ("error" | "warn" | "off")

        Caching:
          --no-cache                     Disable caching
          --cache-location path::String  Path to the cache file or directory - default: .eslintcache
          --cache-strategy String        Strategy to use for detecting changed files in the cache, either metadata or content - default: metadata

        Miscellaneous:
          --error-on-unmatched-pattern   Show errors when any file patterns are unmatched - default: false
          `,
      0
    )
  }

  const baseDir = getProjectDir(args._[0])

  // Check if the provided directory exists
  if (!existsSync(baseDir)) {
    printAndExit(`> No such directory exists as the project root: ${baseDir}`)
  }

  const nextConfig = await loadConfig(PHASE_PRODUCTION_BUILD, baseDir)

  const files: string[] = args['--file'] ?? []
  const dirs: string[] = args['--dir'] ?? nextConfig.eslint?.dirs
  const filesToLint = [...(dirs ?? []), ...files]

  // Remove that when the `appDir` will be stable.
  const directoriesToLint = !!nextConfig.experimental.appDir
    ? ESLINT_DEFAULT_DIRS_WITH_APP
    : ESLINT_DEFAULT_DIRS

  const pathsToLint = (
    filesToLint.length ? filesToLint : directoriesToLint
  ).reduce((res: string[], d: string) => {
    const currDir = join(baseDir, d)
    if (!existsSync(currDir)) return res
    res.push(currDir)
    return res
  }, [])

  const reportErrorsOnly = Boolean(args['--quiet'])
  const maxWarnings = args['--max-warnings'] ?? -1
  const formatter = args['--format'] || null
  const strict = Boolean(args['--strict'])
  const outputFile = args['--output-file'] || null

  const distDir = join(baseDir, nextConfig.distDir)
  const defaultCacheLocation = join(distDir, 'cache', 'eslint/')
  const hasAppDir = !!nextConfig.experimental.appDir

  runLintCheck(baseDir, pathsToLint, hasAppDir, {
    lintDuringBuild: false,
    eslintOptions: eslintOptions(args, defaultCacheLocation),
    reportErrorsOnly: reportErrorsOnly,
    maxWarnings,
    formatter,
    outputFile,
    strict,
  })
    .then(async (lintResults) => {
      const lintOutput =
        typeof lintResults === 'string' ? lintResults : lintResults?.output

      if (typeof lintResults !== 'string' && lintResults?.eventInfo) {
        const telemetry = new Telemetry({
          distDir,
        })
        telemetry.record(
          eventLintCheckCompleted({
            ...lintResults.eventInfo,
            buildLint: false,
          })
        )
        await telemetry.flush()
      }

      if (
        typeof lintResults !== 'string' &&
        lintResults?.isError &&
        lintOutput
      ) {
        throw new CompileError(lintOutput)
      }

      if (lintOutput) {
        printAndExit(lintOutput, 0)
      } else if (lintResults && !lintOutput) {
        printAndExit(chalk.green('✔ No ESLint warnings or errors'), 0)
      }
    })
    .catch((err) => {
      printAndExit(err.message)
    })
}

export { nextLint }
