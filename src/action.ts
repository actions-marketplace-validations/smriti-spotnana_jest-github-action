import { sep, join, resolve } from "path"
import { readFileSync } from "fs"
import { exec } from "@actions/exec"
import * as core from "@actions/core"
import { GitHub, context } from "@actions/github"
import type { Octokit } from "@octokit/rest"
import flatMap from "lodash/flatMap"
import filter from "lodash/filter"
import map from "lodash/map"
import strip from "strip-ansi"
import table from "markdown-table"
import { createCoverageMap, CoverageMapData } from "istanbul-lib-coverage"
import type { FormattedTestResults } from "@jest/test-result/build/types"

const ACTION_NAME = "my-jest-github-action"

// update this header name based on the file run
const COVERAGE_HEADER = ":loop: **Code coverage**\n\n"

export async function run() {
  console.warn("starting the run .........", process.env.GITHUB_TOKEN)
  let workingDirectory = core.getInput("working-directory", { required: false })
  let cwd = workingDirectory ? resolve(workingDirectory) : "src/react"
  // : process.cwd()
  // const cwd = process.env.BRANCH
  // console.log vs console.debug
  console.debug(cwd, "working-directory ...")

  const CWD = cwd + sep

  let reports: string[] = core
    .getInput("reports-array", { required: false })
    .split(" ")
    .filter((x) => x !== "")

  // reports = ["jest.common.json", "jest.web.json", "jest.pixel.json"]

  console.debug(reports, "reports ...")

  // store ALL .json in a common dir, better
  // const RESULTS_FILE_1 = join(CWD, "jest.common.results.json")
  // const RESULTS_FILE_2 = join(CWD, "jest.web.results.json")

  try {
    const token = process.env.GITHUB_TOKEN
    if (token === undefined) {
      core.error("GITHUB_TOKEN not set.")
      core.setFailed("GITHUB_TOKEN not set.")
      return
    }

    // this cmd is not being used anywhere now
    // const cmd = getJestCommand(RESULTS_FILE)

    // don't run the tests here again, since run already
    // await execJest(cmd, CWD)

    // should .json be prefixed with CWD
    // await exec(`nyc merge ${CWD} net-coverage.json`)

    // octokit
    const octokit = new GitHub(token)

    // delete before a fresh run
    await deletePreviousComments(octokit)

    // Parse results
    // const finalResultsFile = join(CWD, "net-coverage.json")

    // loop through all reports
    // why did we not use istanbul for report merge -
    // didn't want to merge into one
    for (let report in reports) {
      const RESULTS_FILE = join(CWD, report)
      console.debug(RESULTS_FILE, CWD, report, "RESULS_FILE CWD report...")
      const results = parseResults(RESULTS_FILE)
      console.debug(results, "results ...")
      // Checks
      const checkPayload = getCheckPayload(results, CWD)
      await octokit.checks.create(checkPayload)

      // Coverage comments

      // post an excel
      // post each as different tabs of excel
      if (getPullId() && shouldCommentCoverage()) {
        const comment = getCoverageTable(results, CWD)
        if (comment) {
          // only deletes related comment, not other db related e.g.
          // don't delete, as we are posting multiple comments
          // await deletePreviousComments(octokit)
          const commentPayload = getCommentPayload(comment)
          await octokit.issues.createComment(commentPayload)
        }
      }

      if (!results.success) {
        core.setFailed("Some jest tests failed.")
      }
    }
  } catch (error) {
    console.error(error)
    core.setFailed(error.message)
  }
}

async function deletePreviousComments(octokit: GitHub) {
  const { data } = await octokit.issues.listComments({
    ...context.repo,
    per_page: 100,
    issue_number: getPullId(),
  })
  return Promise.all(
    data
      .filter(
        (c) =>
          c.user.login === "github-actions[bot]" && c.body.startsWith(COVERAGE_HEADER),
      )
      .map((c) => octokit.issues.deleteComment({ ...context.repo, comment_id: c.id })),
  )
}

function shouldCommentCoverage(): boolean {
  return Boolean(JSON.parse(core.getInput("coverage-comment", { required: false })))
}

function shouldRunOnlyChangedFiles(): boolean {
  return Boolean(JSON.parse(core.getInput("changes-only", { required: false })))
}

export function getCoverageTable(
  results: FormattedTestResults,
  cwd: string,
): string | false {
  if (!results.coverageMap) {
    return ""
  }
  const covMap = createCoverageMap((results.coverageMap as unknown) as CoverageMapData)
  const rows = [["Filename", "Statements", "Branches", "Functions", "Lines"]]

  if (!Object.keys(covMap.data).length) {
    console.error("No entries found in coverage data")
    return false
  }

  for (const [filename, data] of Object.entries(covMap.data || {})) {
    const { data: summary } = data.toSummary()
    rows.push([
      filename.replace(cwd, ""),
      summary.statements.pct + "%",
      summary.branches.pct + "%",
      summary.functions.pct + "%",
      summary.lines.pct + "%",
    ])
  }

  return COVERAGE_HEADER + table(rows, { align: ["l", "r", "r", "r", "r"] })
}

function getCommentPayload(body: string) {
  const payload: Octokit.IssuesCreateCommentParams = {
    ...context.repo,
    body,
    issue_number: getPullId(),
  }
  return payload
}

function getCheckPayload(results: FormattedTestResults, cwd: string) {
  const payload: Octokit.ChecksCreateParams = {
    ...context.repo,
    head_sha: getSha(),
    name: core.getInput("check-name", { required: false }) || ACTION_NAME,
    status: "completed",
    conclusion: results.success ? "success" : "failure",
    output: {
      title: results.success ? "Jest tests passed" : "Jest tests failed",
      text: getOutputText(results),
      summary: results.success
        ? `${results.numPassedTests} tests passing in ${
            results.numPassedTestSuites
          } suite${results.numPassedTestSuites > 1 ? "s" : ""}.`
        : `Failed tests: ${results.numFailedTests}/${results.numTotalTests}. Failed suites: ${results.numFailedTests}/${results.numTotalTestSuites}.`,

      annotations: getAnnotations(results, cwd),
    },
  }
  console.debug("Check payload: %j", payload)
  return payload
}

function getJestCommand(resultsFile: string) {
  let cmd = core.getInput("test-command", { required: false })
  const jestOptions = `--testLocationInResults --json ${
    shouldCommentCoverage() ? "--coverage" : ""
  } ${
    shouldRunOnlyChangedFiles() && context.payload.pull_request?.base.ref
      ? "--changedSince=" + context.payload.pull_request?.base.ref
      : ""
  } --outputFile=${resultsFile}`
  // add support for yarn
  const shouldAddHyphen =
    cmd.startsWith("npm") ||
    cmd.startsWith("npx") ||
    cmd.startsWith("pnpm") ||
    cmd.startsWith("pnpx") ||
    cmd.startsWith("yarn")
  cmd += (shouldAddHyphen ? " -- " : " ") + jestOptions
  core.debug("Final test command: " + cmd)
  return cmd
}

function parseResults(resultsFile: string): FormattedTestResults {
  const results = JSON.parse(readFileSync(resultsFile, "utf-8"))
  console.debug("Jest results: %j", results)
  return results
}

async function execJest(cmd: string, cwd?: string) {
  try {
    await exec(cmd, [], { silent: true, cwd })
    console.debug("Jest command executed")
  } catch (e) {
    console.error("Jest execution failed. Tests have likely failed.", e)
  }
}

function getPullId(): number {
  return context.payload.pull_request?.number ?? 0
}

function getSha(): string {
  return context.payload.pull_request?.head.sha ?? context.sha
}

const getAnnotations = (
  results: FormattedTestResults,
  cwd: string,
): Octokit.ChecksCreateParamsOutputAnnotations[] => {
  if (results.success) {
    return []
  }
  return flatMap(results.testResults, (result) => {
    return filter(result.assertionResults, ["status", "failed"]).map((assertion) => ({
      path: result.name.replace(cwd, ""),
      start_line: assertion.location?.line ?? 0,
      end_line: assertion.location?.line ?? 0,
      annotation_level: "failure",
      title: assertion.ancestorTitles.concat(assertion.title).join(" > "),
      message: strip(assertion.failureMessages?.join("\n\n") ?? ""),
    }))
  })
}

const getOutputText = (results: FormattedTestResults) => {
  if (results.success) {
    return
  }
  const entries = filter(map(results.testResults, (r) => strip(r.message)))
  return asMarkdownCode(entries.join("\n"))
}

export function asMarkdownCode(str: string) {
  return "```\n" + str.trimRight() + "\n```"
}
