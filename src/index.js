const core = require('@actions/core');
const github = require('@actions/github');
const axios = require('axios');

async function getPRDiff(octokit, context) {
  try {
    const { data: pullRequest } = await octokit.rest.pulls.get({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.payload.pull_request.number,
      mediaType: {
        format: 'diff',
      },
    });

    return pullRequest;
  } catch (error) {
    throw new Error(`Failed to fetch PR diff: ${error.message}`);
  }
}

async function shouldReviewPR(octokit, context, requiredLabel) {
  if (!requiredLabel) {
    return true;
  }

  try {
    const { data: labels } = await octokit.rest.issues.listLabelsOnIssue({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: context.payload.pull_request.number,
    });

    return labels.some((label) => label.name === requiredLabel);
  } catch (error) {
    throw new Error(`Failed to fetch PR labels: ${error.message}`);
  }
}

const REVIEW_MARKER = '## DiffGuard AI Analysis';

/**
 * Collects every review this action has already posted on the PR.
 *
 * Both output paths carry REVIEW_MARKER, but they land in different places:
 * inline mode creates a pull request *review*, the fallback path creates an
 * *issue comment*. Querying only comments (as this used to) leaves the review
 * count and the cooldown permanently blind in inline mode, so both are read.
 *
 * Matching on the marker instead of on "any bot" also stops Dependabot,
 * CodeRabbit or a release bot from being counted as one of our reviews.
 *
 * @returns {Promise<{count: number, latestAt: Date|null, latestSha: string|null}>}
 */
async function getPriorReviews(octokit, context) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const pull_number = context.payload.pull_request.number;
  const entries = [];

  try {
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: pull_number,
      per_page: 100,
    });
    for (const comment of comments) {
      if (comment.body?.includes(REVIEW_MARKER)) {
        entries.push({ at: new Date(comment.created_at), sha: null });
      }
    }
  } catch (error) {
    core.warning(`Failed to list PR comments: ${error.message}`);
  }

  try {
    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number,
      per_page: 100,
    });
    for (const review of reviews) {
      if (review.body?.includes(REVIEW_MARKER)) {
        entries.push({
          at: new Date(review.submitted_at),
          sha: review.commit_id || null,
        });
      }
    }
  } catch (error) {
    core.warning(`Failed to list PR reviews: ${error.message}`);
  }

  entries.sort((a, b) => a.at - b.at);
  const withSha = entries.filter((entry) => entry.sha);

  return {
    count: entries.length,
    latestAt: entries.length ? entries[entries.length - 1].at : null,
    latestSha: withSha.length ? withSha[withSha.length - 1].sha : null,
  };
}

/**
 * @returns {{shouldSkip: boolean, message: string}}
 */
function checkReviewCount(prior, maxReviews) {
  core.info(`Current DiffGuard review count: ${prior.count} (max: ${maxReviews})`);

  if (prior.count >= maxReviews) {
    return {
      shouldSkip: true,
      message: `Maximum review limit reached (${maxReviews}). Skipping review to save credits.`,
    };
  }

  return { shouldSkip: false, message: '' };
}

/**
 * @returns {{shouldSkip: boolean, message: string}}
 */
function checkCooldown(prior, cooldownMinutes) {
  if (cooldownMinutes <= 0 || !prior.latestAt) {
    return { shouldSkip: false, message: '' };
  }

  const timeSinceLastReview = Date.now() - prior.latestAt.getTime();
  const cooldownMs = cooldownMinutes * 60 * 1000;

  core.info(
    `Last review was at ${prior.latestAt.toISOString()} (${Math.round(
      timeSinceLastReview / 1000
    )}s ago); cooldown is ${cooldownMinutes}m`
  );

  if (timeSinceLastReview < cooldownMs) {
    const remainingMinutes = Math.ceil(
      (cooldownMs - timeSinceLastReview) / (60 * 1000)
    );
    return {
      shouldSkip: true,
      message: `Cooldown active. Last review was ${Math.round(
        timeSinceLastReview / 1000
      )}s ago. Please wait ${remainingMinutes} more minutes.`,
    };
  }

  return { shouldSkip: false, message: '' };
}

/**
 * Diff of everything pushed since the last review this action posted.
 *
 * Anchored on that review's own head commit rather than on the push event's
 * `before` SHA: when a push's review is skipped (cooldown, queue, transient
 * model failure) the commits it carried would otherwise never be looked at by
 * any run.
 *
 * @returns {Promise<string|null>} the diff, or null when it cannot be computed
 */
async function getDiffSince(octokit, context, baseSha) {
  const headSha = context.payload.pull_request.head?.sha;
  if (!baseSha || !headSha || baseSha === headSha) {
    return null;
  }

  try {
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner: context.repo.owner,
      repo: context.repo.repo,
      basehead: `${baseSha}...${headSha}`,
      mediaType: { format: 'diff' },
    });
    return typeof data === 'string' && data.trim() ? data : null;
  } catch (error) {
    // A rebase or force-push can leave the previously reviewed SHA unreachable.
    core.warning(
      `Could not diff ${baseSha}...${headSha} (${error.message}). Reviewing the whole PR instead.`
    );
    return null;
  }
}

async function analyzeDiff(diff, modelId, openRouterKey, customPrompt, reasoningEffort, maxTokens, contextBlock, inlineComments, prMetadataBlock, reviewScopeBlock) {
  const defaultPrompt = `You are a highly skilled staff software engineer reviewing a pull request. 

Avoid generic BS advice. For each advice, please provide a file Path of the related change. No need to paste the code itself.

Do not mention what's good on the code. Just focus on what's bad and how to improve.

Analyze the following code changes and provide a detailed review in the following format. MAKE SURE TO ADHERE TO THIS FORMAT!

For each category below, except for the overall score, rate the issue in terms of severity (low 🔵, medium 🟡, high 🔥).

Here's your text with added emojis:

---

### 🏆 Overall Score  
[Give a 1-5 ⭐ rating for this PR] and final comments

### 🐞 Potential Issues  
[List any bugs, vulnerabilities, or critical issues]

### 💡 Improvements Suggested  
[List specific code improvements and refactoring suggestions]

### ⚡️ Performance  
[Discuss performance implications and optimization opportunities]

### 🔐 Security Concerns  
[List security issues, if any]

### 📏 Best Practices  
[Suggest adherence to coding standards and best practices] 

### 🧪 Missing Tests  
[List any missing or insufficient tests, and suggest specific tests that should be added. Be concrete and actionable.]

Please be specific and provide actionable feedback. No generic BS advice.`;

  const prompt = customPrompt || defaultPrompt;

  // In inline mode the reply must be machine-readable so each finding can be
  // anchored to a line, so the caller's output-format instructions are
  // replaced by a JSON contract. Everything else in their prompt still applies.
  const outputContract = inlineComments
    ? `\n\nOUTPUT FORMAT — this overrides any formatting instructions above.
Reply with a single JSON object and nothing else. No prose, no markdown fence.

{
  "summary": "At most two sentences framing the change as a whole. This is NOT where problems go — never describe a problem, a risk, or a rule violation here. If you catch yourself writing one, it belongs in findings instead. Empty string is fine.",
  "score": 0,
  "findings": [
    {
      "path": "path/to/file.kt",
      "line": 42,
      "severity": "low" | "medium" | "high",
      "title": "Short label, under 80 characters",
      "body": "What breaks and under which inputs or state. Markdown allowed."
    }
  ]
}

Rules for "path" and "line":
- "path" is the file path exactly as it appears in the diff, with no a/ or b/ prefix.
- "line" is a line number in the NEW version of the file, and it MUST be a line
  the diff ADDS (a '+' line). Never point at a context line, a removed line, or
  a line the diff does not touch.
- If a finding is not tied to one specific added line, you MUST omit "path"
  and "line" entirely. Never anchor such a finding to an arbitrary line, a
  blank line, or a comment just to have somewhere to put it — an unanchored
  finding is reported in full, so there is nothing to gain by guessing.
  Anything about the pull request as a whole belongs in this category: its
  title, its labels, its body, its branch name.
- "score" is 0-100 for the overall change. Omit it if you were not asked to score.
- "findings": [] means you found nothing at all. It must be consistent with
  "summary": an empty findings list next to a summary that describes a problem
  is a contradiction. Do not invent findings either — a clean diff is normal.
- Treat supplied project conventions as facts about the team's RULES only.
  They are not evidence about what the code contains. Doc files rot: version
  numbers, paths, module lists and whole "this project does X" descriptions
  go stale while the rules around them stay valid. Never report a finding
  whose entire basis is that a convention file disagrees with the diff, and
  never conclude a feature, domain or dependency is absent because a doc did
  not mention it — you are shown a diff, not the repository, so absence of
  evidence is not evidence of absence. Where a doc and the code conflict, the
  code wins.`
    : '\n\nProvide your analysis in the specified format.';

  const fullPrompt = `${prompt}${contextBlock || ''}${prMetadataBlock || ''}\n\nHere's the diff:\n${diff}${reviewScopeBlock || ''}${outputContract}`;

  try {
    const requestBody = {
      model: modelId,
      messages: [
        {
          role: 'user',
          content: fullPrompt,
        },
      ],
      max_tokens: maxTokens || 4096,
    };

    // Add reasoning effort if specified (for reasoning models).
    // OpenRouter's canonical field is `reasoning: { effort }`; the flat
    // `reasoning_effort` alias is not honoured by every upstream provider.
    if (reasoningEffort) {
      requestBody.reasoning = { effort: reasoningEffort };
    }

    // Ask the provider to constrain output to JSON when we need to parse it.
    // Not every model honours this, hence the tolerant parse on the way back.
    if (inlineComments) {
      requestBody.response_format = { type: 'json_object' };
    }

    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${openRouterKey}`,
          'HTTP-Referer': 'https://github.com/marketplace',
          'Content-Type': 'application/json',
        },
      }
    );

    const data = response.data;

    // OpenRouter can answer HTTP 200 with an error envelope instead of choices
    // (no endpoint matching the account's data policy, upstream provider error,
    // moderation). Surface it verbatim rather than as "invalid response format".
    if (data?.error) {
      throw new Error(
        `OpenRouter returned an error: ${JSON.stringify(data.error)}`
      );
    }

    const choice = data?.choices?.[0];
    const finishReason = choice?.finish_reason || choice?.native_finish_reason;

    if (data?.usage) {
      core.info(
        `Token usage: prompt=${data.usage.prompt_tokens} completion=${data.usage.completion_tokens} total=${data.usage.total_tokens}`
      );
    }
    core.info(`Finish reason: ${finishReason || 'unknown'}`);

    let content = choice?.message?.content;

    // Hybrid reasoning models (GLM, DeepSeek R1, ...) put their thinking in
    // `reasoning` and can return an empty `content` when max_tokens runs out
    // mid-thought. The reasoning text is still a usable review, so use it.
    if (!content || !content.trim()) {
      const reasoning = choice?.message?.reasoning;
      if (reasoning && reasoning.trim()) {
        core.warning(
          `Model returned empty content but non-empty reasoning (finish_reason=${finishReason}). Falling back to the reasoning text — consider raising max_tokens.`
        );
        content = reasoning;
      }
    }

    if (!content || !content.trim()) {
      // Log the raw envelope so a failure is diagnosable from the job log.
      // It contains no credentials — the API key only ever travels in headers.
      core.error(
        `Unusable OpenRouter response. Raw body (truncated): ${JSON.stringify(
          data
        ).slice(0, 2000)}`
      );
      if (finishReason === 'length') {
        throw new Error(
          `Model hit the max_tokens limit (${requestBody.max_tokens}) before emitting any text. Raise max_tokens, or lower reasoning_effort.`
        );
      }
      throw new Error(
        `OpenRouter returned no usable content for model "${modelId}" (finish_reason=${finishReason}). See the raw body logged above.`
      );
    }

    return content;
  } catch (error) {
    if (error.response?.data) {
      throw new Error(
        `OpenRouter API error: ${JSON.stringify(error.response.data)}`
      );
    }
    throw new Error(`Failed to analyze diff: ${error.message}`);
  }
}

/**
 * Reads project convention files (CLAUDE.md, .claude/rules/**) from the
 * checked-out workspace so the model reviews against the team's actual rules
 * instead of generic best practice. Requires actions/checkout in the workflow.
 *
 * @param {string} globsInput - comma-separated glob patterns
 * @param {number} maxBytes - hard cap on total context size
 * @returns {Promise<string>} formatted context block, or '' if nothing matched
 */
async function loadContextFiles(globsInput, maxBytes) {
  if (!globsInput || !globsInput.trim()) return '';

  const fs = require('fs');
  const path = require('path');

  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const patterns = globsInput
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  // fs.globSync keeps this dependency-free. @actions/glob would be the
  // obvious choice, but its exports map does not resolve under the ncc
  // version that builds dist/, and it fails the build silently.
  if (typeof fs.globSync !== 'function') {
    core.warning(
      'fs.globSync is unavailable on this Node runtime; skipping context_files.'
    );
    return '';
  }

  let files;
  try {
    const seen = new Set();
    for (const pattern of patterns) {
      for (const match of fs.globSync(pattern, { cwd: workspace })) {
        seen.add(path.resolve(workspace, match));
      }
    }
    files = [...seen].sort();
  } catch (error) {
    core.warning(`Failed to expand context_files globs: ${error.message}`);
    return '';
  }

  if (files.length === 0) {
    core.warning(
      `context_files matched no files. Is actions/checkout present in the job? Patterns: ${globsInput}`
    );
    return '';
  }

  const parts = [];
  const included = [];
  const skipped = [];
  let total = 0;

  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    if (total + stat.size > maxBytes) {
      skipped.push(path.relative(workspace, file));
      continue;
    }

    let body;
    try {
      body = fs.readFileSync(file, 'utf8');
    } catch (error) {
      core.warning(`Could not read ${file}: ${error.message}`);
      continue;
    }

    const rel = path.relative(workspace, file);
    parts.push(`--- ${rel} ---\n${body.trim()}`);
    included.push(rel);
    total += stat.size;
  }

  if (included.length === 0) return '';

  core.info(
    `Loaded ${included.length} context file(s), ${total} bytes: ${included.join(', ')}`
  );
  if (skipped.length > 0) {
    core.warning(
      `Skipped ${skipped.length} context file(s) — context_max_bytes (${maxBytes}) reached: ${skipped.join(', ')}`
    );
  }

  return `\n\nPROJECT CONVENTIONS\nThese are this team's binding conventions. A change that violates one is a\nfinding even if it would be acceptable in a generic codebase. Cite the rule\nfile when you rely on it. Do not restate rules the diff does not touch.\n\n${parts.join('\n\n')}\n`;
}

/**
 * Builds the set of lines that GitHub will accept an inline comment on:
 * added ('+') lines on the right-hand side of the unified diff.
 *
 * GitHub rejects an entire review if any single comment targets a line
 * outside the diff, so every finding is validated against this map first.
 *
 * @param {string} diff - unified diff
 * @returns {Map<string, Set<number>>} path -> commentable new-file line numbers
 */
function parseCommentableLines(diff) {
  const targets = new Map();
  let currentPath = null;
  let newLine = 0;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      currentPath = null;
      continue;
    }
    if (raw.startsWith('--- ')) continue;
    if (raw.startsWith('+++ ')) {
      const target = raw.slice(4).trim();
      currentPath =
        target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (currentPath && !targets.has(currentPath)) {
        targets.set(currentPath, new Set());
      }
      continue;
    }

    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = parseInt(hunk[1], 10);
      continue;
    }

    if (!currentPath) continue;
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"

    if (raw.startsWith('+')) {
      targets.get(currentPath).add(newLine);
      newLine += 1;
    } else if (raw.startsWith('-')) {
      // removed line: consumes no line number in the new file
    } else {
      newLine += 1; // context line
    }
  }

  return targets;
}

/**
 * Pulls the first JSON value out of a model reply that may be fenced, padded
 * with prose, or a bare array rather than an object.
 */
function extractJsonObject(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();

  // Whichever of { or [ appears first wins, so a bare findings array parses
  // instead of the extractor grabbing the first object nested inside it.
  const openers = [
    ['{', '}'],
    ['[', ']'],
  ]
    .map(([open, close]) => ({
      start: candidate.indexOf(open),
      end: candidate.lastIndexOf(close),
    }))
    .filter(({ start, end }) => start !== -1 && end > start)
    .sort((a, b) => a.start - b.start);

  for (const { start, end } of openers) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // try the next opener
    }
  }
  return null;
}

/**
 * Describes the pull request itself — title, labels, body — so the model can
 * judge conventions that live in PR metadata rather than in the code.
 *
 * Without this the model cannot see whether a required label or PR-body
 * section is present, and reports it as missing on every run.
 */
function buildPrMetadataBlock(context) {
  const pr = context.payload.pull_request;
  if (!pr) return '';

  const labels = (pr.labels || []).map((label) => label.name);
  const body = (pr.body || '').trim();

  return `\n\nPULL REQUEST METADATA
This is the current state of the PR itself. Conventions about the PR — its
title format, required labels, required body sections — are checked against
this, not against the diff. Do not report something here as missing when it
is present below.

Title: ${pr.title || '(none)'}
Labels: ${labels.length ? labels.join(', ') : '(none)'}
Head branch: ${pr.head && pr.head.ref ? pr.head.ref : '(unknown)'}
Body:
${body || '(empty)'}
`;
}

/**
 * Finds the review object in whatever shape the model replied with.
 *
 * Providers wrap JSON-mode output inconsistently: Z.ai returns the review
 * stringified inside {"answer": "..."}, others nest it under "response" or
 * "result", and some return a bare findings array. Rather than special-case
 * each wrapper key, walk the structure until an object with a findings array
 * turns up, unwrapping JSON-in-a-string at every level.
 *
 * @returns {object|null} an object with a findings array, or null
 */
function coerceReviewObject(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return null;

  if (typeof value === 'string') {
    const inner = extractJsonObject(value);
    return inner ? coerceReviewObject(inner, depth + 1) : null;
  }

  if (typeof value !== 'object') return null;

  // A bare array of findings, with no envelope at all.
  if (Array.isArray(value)) {
    const allObjects =
      value.length > 0 &&
      value.every((entry) => entry && typeof entry === 'object');
    return allObjects ? { summary: '', findings: value } : null;
  }

  if (Array.isArray(value.findings)) return value;

  for (const nested of Object.values(value)) {
    const found = coerceReviewObject(nested, depth + 1);
    if (found) return found;
  }

  return null;
}

const SEVERITY_ICON = { high: '🔥', medium: '🟡', low: '🔵' };
const SEVERITY_RANK = { low: 1, medium: 2, high: 3 };

/** First line of every inline finding this action posts: icon, severity, title. */
const FINDING_HEADING = /^\s*(?:🔥|🟡|🔵)?\s*\*\*(high|medium|low)\*\*\s*(.*)$/;

function normaliseTitle(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Reads back the inline findings this action already posted on the PR, so the
 * next push does not raise them a second time.
 *
 * Two keys are kept because neither alone holds up. GitHub re-anchors a
 * comment's `line` as the diff evolves and nulls it once the thread goes
 * outdated, so path:line drifts away from the finding; and the model rewords a
 * title between runs, so titles alone miss. A hit on either counts as already
 * reported — over-suppressing one repeat costs a comment, while under-
 * suppressing is the failure the author actually complains about.
 *
 * @returns {Promise<{anchors: Set<string>, titles: Set<string>, count: number}>}
 */
async function loadReportedFindings(octokit, context) {
  const reported = { anchors: new Set(), titles: new Set(), count: 0 };

  let comments;
  try {
    comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.payload.pull_request.number,
      per_page: 100,
    });
  } catch (error) {
    core.warning(
      `Failed to list existing review comments: ${error.message}. Duplicate suppression is off for this run.`
    );
    return reported;
  }

  for (const comment of comments) {
    if (comment.user?.type !== 'Bot') continue;

    const heading = String(comment.body || '')
      .split('\n')[0]
      .match(FINDING_HEADING);
    if (!heading) continue;

    reported.count += 1;

    const title = normaliseTitle(heading[2]);
    if (title) reported.titles.add(title);

    const line = comment.line ?? comment.original_line;
    if (comment.path && Number.isInteger(line)) {
      reported.anchors.add(`${comment.path}:${line}`);
    }
  }

  core.info(`${reported.count} finding(s) already reported on this PR.`);
  return reported;
}

/**
 * Drops the findings the team asked not to see: below the severity floor,
 * already reported on an earlier push, or outside the lines the latest push
 * added.
 *
 * All three rules are enforced here rather than left to the prompt. The
 * instructions still go to the model so it does not waste its budget, but a
 * review pipeline must not depend on a model reliably obeying "do not repeat
 * yourself".
 *
 * @returns {{kept: object[], dropped: {severity: number, duplicate: number, outOfScope: number}}}
 */
function selectFindings(findings, { severityFloor, reported, scope }) {
  const kept = [];
  const dropped = { severity: 0, duplicate: 0, outOfScope: 0 };

  for (const finding of findings || []) {
    const severity = String(finding.severity || '').toLowerCase();
    const rank = SEVERITY_RANK[severity] || 0;

    // rank 0 is an unrecognised severity: keep it rather than silently
    // swallowing a finding because the model mislabelled it.
    if (rank > 0 && rank < severityFloor) {
      dropped.severity += 1;
      continue;
    }

    const path = finding.path && String(finding.path).replace(/^b\//, '');
    const line = Number(finding.line);
    const anchored = Boolean(path) && Number.isInteger(line);

    if (scope) {
      // An unanchored finding is about the pull request as a whole - its
      // title, labels, body, branch name. That was reported when the PR was
      // opened and nothing in a later push changes it, so it would come back
      // on every single push.
      if (!anchored || !scope.get(path)?.has(line)) {
        dropped.outOfScope += 1;
        continue;
      }
    }

    if (reported) {
      const title = normaliseTitle(finding.title);
      const isDuplicate =
        (anchored && reported.anchors.has(`${path}:${line}`)) ||
        (Boolean(title) && reported.titles.has(title));
      if (isDuplicate) {
        dropped.duplicate += 1;
        continue;
      }
    }

    kept.push(finding);
  }

  return { kept, dropped };
}

/**
 * Tells the model what this run is allowed to report. The filter in
 * selectFindings is the authority; this only stops the model spending its
 * output budget on findings that would be thrown away.
 */
function buildReviewScopeBlock({ severityFloor, reported, incrementalDiff }) {
  const parts = [];

  if (severityFloor > 1) {
    const floorName = Object.keys(SEVERITY_RANK).find(
      (name) => SEVERITY_RANK[name] === severityFloor
    );
    parts.push(`SEVERITY FLOOR
Report only findings of severity ${floorName} or above. A lower-severity
nitpick is not worth a reviewer's attention here: leave it out entirely rather
than mentioning it in the summary or downgrading it into another finding.`);
  }

  if (reported && reported.titles.size > 0) {
    parts.push(`ALREADY REPORTED - DO NOT REPEAT
These findings were posted on an earlier push of this same pull request. The
author has seen each one and either fixed it or answered it. Raising any of
them again, in any wording, is this review's worst failure mode. If you
believe one was answered wrongly, stay silent - a human reviewer owns that
argument, not you.

${[...reported.titles].map((title) => `- ${title}`).join('\n')}`);
  }

  if (incrementalDiff) {
    parts.push(`IN SCOPE FOR THIS RUN
The whole pull request is shown above for context, but only the changes below
were pushed since the last review. Anchor every finding to a line that this
newer diff adds; anything else is discarded before posting. Say nothing about
the pull request as a whole - its title, labels, body or branch name - that
was covered when the PR was opened.

${incrementalDiff}`);
  }

  return parts.length ? `\n\n${parts.join('\n\n')}\n` : '';
}

/**
 * Resolves this action's own review threads that GitHub has marked outdated:
 * the line the finding pointed at has since been rewritten, so the comment no
 * longer describes the code and only clutters the conversation.
 *
 * Only outdated threads are touched. "The author changed this line" is a fact
 * GitHub computes; "the author fixed the bug" is not, and resolving on that
 * guess would bury real findings. The comment stays readable under the fold
 * and a human can reopen the thread.
 *
 * @returns {Promise<number>} how many threads were resolved
 */
async function resolveOutdatedThreads(octokit, context) {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              isResolved
              isOutdated
              comments(first: 1) {
                nodes { body author { login __typename } }
              }
            }
          }
        }
      }
    }`;

  const stale = [];
  let cursor = null;

  try {
    for (;;) {
      const result = await octokit.graphql(query, {
        owner: context.repo.owner,
        repo: context.repo.repo,
        number: context.payload.pull_request.number,
        cursor,
      });
      const threads = result.repository.pullRequest.reviewThreads;

      for (const thread of threads.nodes) {
        if (thread.isResolved || !thread.isOutdated) continue;

        const first = thread.comments.nodes[0];
        if (!first || first.author?.__typename !== 'Bot') continue;
        if (!FINDING_HEADING.test(String(first.body || '').split('\n')[0])) {
          continue;
        }

        stale.push(thread.id);
      }

      if (!threads.pageInfo.hasNextPage) break;
      cursor = threads.pageInfo.endCursor;
    }
  } catch (error) {
    core.warning(`Could not list review threads: ${error.message}`);
    return 0;
  }

  const mutation = `
    mutation($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
    }`;

  let resolved = 0;
  for (const threadId of stale) {
    try {
      await octokit.graphql(mutation, { threadId });
      resolved += 1;
    } catch (error) {
      core.warning(`Could not resolve thread ${threadId}: ${error.message}`);
    }
  }

  if (resolved > 0) {
    core.info(
      `Resolved ${resolved} outdated finding thread(s) whose anchored lines have changed.`
    );
  }
  return resolved;
}

/** Renders one finding as the body of an inline comment. */
function renderFinding(finding) {
  const severity = String(finding.severity || '').toLowerCase();
  const icon = SEVERITY_ICON[severity] || '';
  const heading = [icon, severity && `**${severity}**`, finding.title]
    .filter(Boolean)
    .join(' ');
  return heading ? `${heading}\n\n${finding.body || ''}`.trim() : String(finding.body || '');
}

/**
 * Posts the review as inline comments anchored to the changed lines, with
 * anything unanchorable rolled into the review summary so no finding is lost.
 *
 * @returns {Promise<boolean>} true if an inline review was posted
 */
async function createInlineReview(octokit, context, parsed, diff, headerMsg, notes) {
  const commentable = parseCommentableLines(diff);
  const inline = [];
  const orphans = [];

  for (const finding of parsed.findings || []) {
    const path = finding.path && finding.path.replace(/^b\//, '');
    const line = Number(finding.line);
    const anchored =
      path &&
      Number.isInteger(line) &&
      commentable.has(path) &&
      commentable.get(path).has(line);

    if (anchored) {
      inline.push({ path, line, side: 'RIGHT', body: renderFinding(finding) });
    } else {
      if (path) {
        core.info(
          `Finding for ${path}:${finding.line} is not on a changed line — moving it to the summary.`
        );
      }
      // Rendered as a flat bullet: the empty bold markers this used to emit
      // around an absent path showed up as literal '****' in the review.
      const where = path
        ? `\`${path}${finding.line ? `:${finding.line}` : ''}\` — `
        : '';
      const severity = String(finding.severity || '').toLowerCase();
      const badge = [SEVERITY_ICON[severity] || '', severity && `**${severity}**`]
        .filter(Boolean)
        .join(' ');
      const title = finding.title ? `${finding.title}` : '';
      const detail = String(finding.body || '')
        .replace(/\s*\n+\s*/g, ' ')
        .trim();
      orphans.push(
        `- ${[where + badge, title, detail].filter(Boolean).join(' — ')}`
      );
    }
  }

  const summaryParts = [headerMsg, '## DiffGuard AI Analysis', ''];
  if (parsed.summary) summaryParts.push(parsed.summary, '');
  if (inline.length > 0) {
    summaryParts.push(
      `${inline.length} finding(s) posted inline on the changed lines.`,
      ''
    );
  }
  if (orphans.length > 0) {
    summaryParts.push(
      '### Not tied to a changed line',
      ...orphans,
      ''
    );
  }
  if (inline.length === 0 && orphans.length === 0) {
    summaryParts.push('No findings.', '');
  }
  // Say what this run covered and what it deliberately left out, so nobody has
  // to guess whether the review is still thinking or simply had nothing to add.
  if (notes && notes.length > 0) {
    summaryParts.push('<sub>', ...notes.map((note) => `${note}<br>`), '</sub>', '');
  }
  summaryParts.push(
    '---',
    `*Analyzed using ${core.getInput('model_id')}*`
  );
  const body = summaryParts.filter((p) => p !== undefined).join('\n');

  try {
    await octokit.rest.pulls.createReview({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.payload.pull_request.number,
      event: 'COMMENT',
      body,
      comments: inline,
    });
    core.info(
      `Inline review posted: ${inline.length} inline comment(s), ${orphans.length} in the summary.`
    );
    return true;
  } catch (error) {
    // A single bad anchor 422s the whole review. Rather than lose the
    // analysis, fall back to one plain comment containing everything.
    core.warning(
      `Inline review failed (${error.message}); falling back to a single summary comment.`
    );
    return false;
  }
}

async function createPRComment(octokit, context, analysis) {
  try {
    await octokit.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: context.payload.pull_request.number,
      body: `## DiffGuard AI Analysis

${analysis}

---
*Analyzed using ${core.getInput('model_id')}*`,
    });
  } catch (error) {
    throw new Error(`Failed to create PR comment: ${error.message}`);
  }
}

/**
 * Filters out excluded files from the diff
 * @param {string} diff - The PR diff content
 * @param {string[]} excludePatterns - Array of file patterns to exclude
 * @returns {string} Filtered diff content
 */
function filterExcludedFiles(diff, excludePatterns) {
  if (!excludePatterns || excludePatterns.length === 0) {
    return diff;
  }

  core.info(`Original diff length: ${diff.length} characters`);

  // Debug: Check if the diff contains common lock files
  core.info(`Diff contains 'yarn.lock': ${diff.includes('yarn.lock')}`);
  core.info(
    `Diff contains 'package-lock.json': ${diff.includes('package-lock.json')}`
  );
  core.info(`Diff contains 'package.lock': ${diff.includes('package.lock')}`);

  // Split the diff into file sections
  const fileSections = diff.split('diff --git');
  core.info(`Split diff into ${fileSections.length} sections`);

  // Keep the first empty section (if any) and filter the rest
  const filteredSections = [fileSections[0]];
  const excludedFiles = [];

  for (let i = 1; i < fileSections.length; i++) {
    const section = fileSections[i];

    // Extract the file path from the diff section
    // Look for both a/ and b/ paths as they both should contain the filename
    const filePathMatchA = section.match(/a\/([^\s]+)/);
    const filePathMatchB = section.match(/b\/([^\s]+)/);

    core.debug(
      `Section ${i} - a/ match: ${
        filePathMatchA ? filePathMatchA[1] : 'None'
      }, b/ match: ${filePathMatchB ? filePathMatchB[1] : 'None'}`
    );

    if (!filePathMatchA && !filePathMatchB) {
      core.info(
        `Couldn't extract file path from section ${i}, including it by default`
      );
      filteredSections.push(section);
      continue;
    }

    // Use the first match found (preferring a/ path)
    const filePath = filePathMatchA ? filePathMatchA[1] : filePathMatchB[1];
    core.debug(`Processing file: ${filePath}`);

    // Check if this file should be excluded
    let shouldExclude = false;
    let matchedPattern = '';

    for (const pattern of excludePatterns) {
      core.debug(`  Checking against pattern: '${pattern}'`);

      // Handle exact filename matches (common case)
      if (filePath.endsWith(pattern) || filePath === pattern) {
        core.debug(`  -> Direct match with '${pattern}'`);
        shouldExclude = true;
        matchedPattern = pattern;
        break;
      }

      // Simplified approach for common filenames (checking file basename)
      const fileName = filePath.split('/').pop();
      if (fileName === pattern) {
        core.debug(`  -> Basename match with '${pattern}'`);
        shouldExclude = true;
        matchedPattern = pattern;
        break;
      }

      // Convert glob pattern to regex for more complex patterns
      try {
        const regexPattern = pattern
          .replace(/\./g, '\\.')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.');

        const regex = new RegExp(`^${regexPattern}$`);
        core.debug(`  -> Testing regex: ${regex}`);
        if (regex.test(filePath)) {
          core.debug(`  -> Regex match with '${pattern}'`);
          shouldExclude = true;
          matchedPattern = pattern;
          break;
        }
      } catch (error) {
        core.warning(`Invalid regex pattern ${pattern}: ${error.message}`);
      }
    }

    if (!shouldExclude) {
      filteredSections.push(section);
      core.debug(`Including file in analysis: ${filePath}`);
    } else {
      excludedFiles.push(filePath);
      core.info(
        `Excluding file from analysis: ${filePath} (matched pattern: ${matchedPattern})`
      );
    }
  }

  // Log summary of excluded files
  if (excludedFiles.length > 0) {
    core.info(
      `Excluded ${
        excludedFiles.length
      } files from analysis: ${excludedFiles.join(', ')}`
    );
  } else {
    core.warning(
      'No files were excluded despite exclude patterns being provided'
    );
  }

  // Reconstruct the diff, adding 'diff --git' back except for the first section
  const filteredDiff =
    filteredSections[0] +
    filteredSections
      .slice(1)
      .map((section) => `diff --git${section}`)
      .join('');

  core.info(
    `Filtered diff length: ${filteredDiff.length} characters (${Math.round(
      (filteredDiff.length / diff.length) * 100
    )}% of original)`
  );

  // If filtered diff is very short or empty, this could be a problem
  if (filteredDiff.length < 100) {
    core.warning(
      `WARNING: Filtered diff is very short (${filteredDiff.length} chars), this might cause an API error`
    );
    if (filteredDiff.length === 0) {
      core.warning(
        `All files were excluded, but an empty diff will cause an API error`
      );
      // Return a minimal valid diff to prevent API errors
      return 'diff --git a/README.md b/README.md\nindex 1234567..abcdefg 100644\n--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,1 @@\n-# No changes to analyze\n+# No changes to analyze after exclusions';
    }
  }

  return filteredDiff;
}

// Add a function to extract the score from the AI's analysis
function extractScore(analysis) {
  // Try to find a 0-100 score (e.g., "Score: 72" or "Overall Score: 72")
  const hundredMatch = analysis.match(/Score.*?([0-9]{1,3})/i);
  if (hundredMatch) {
    const score = parseInt(hundredMatch[1], 10);
    if (!isNaN(score)) return score;
  }
  // Try to find a 1-5 star rating (e.g., "[3.5/5 ⭐]")
  const starMatch = analysis.match(/\[([0-9.]+)\/5 ?⭐/i);
  if (starMatch) {
    const stars = parseFloat(starMatch[1]);
    if (!isNaN(stars)) return Math.round((stars / 5) * 100);
  }
  return null; // Could not extract score
}

async function run() {
  try {
    // Get inputs
    const openRouterKey = core.getInput('open_router_key', { required: true });
    const modelId = core.getInput('model_id', { required: true });
    const customPrompt = core.getInput('custom_prompt');
    const reviewLabel = core.getInput('review_label');
    const excludeFilesInput = core.getInput('exclude_files');
    const reasoningEffort = core.getInput('reasoning_effort');
    const contextFilesInput = core.getInput('context_files');
    const contextMaxBytes = parseInt(
      core.getInput('context_max_bytes') || '262144',
      10
    );
    const inlineComments = core.getInput('inline_comments') === 'true';
    const maxTokens = parseInt(core.getInput('max_tokens') || '4096', 10);
    const maxPrReviews = parseInt(core.getInput('max_pr_reviews') || '10', 10);
    const cooldownPeriod = parseInt(core.getInput('cooldown_period') || '0', 10);
    const severityFloor =
      SEVERITY_RANK[(core.getInput('severity_threshold') || 'low').toLowerCase()] ||
      SEVERITY_RANK.low;
    // Both only make sense against per-finding output, which is inline mode.
    const incrementalReviews =
      inlineComments && core.getInput('incremental_reviews') === 'true';
    const suppressDuplicates =
      inlineComments && core.getInput('suppress_duplicates') !== 'false';
    const resolveThreads = core.getInput('resolve_outdated_threads') === 'true';

    // Process exclude patterns
    const excludePatterns = excludeFilesInput
      ? excludeFilesInput.split(',').map((pattern) => pattern.trim())
      : [];

    core.info(`=== DiffGuard Debug Information ===`);
    core.info(`Model ID: ${modelId}`);
    core.info(`Review Label: ${reviewLabel || 'None'}`);
    core.info(
      `Exclude Patterns (${excludePatterns.length}): ${JSON.stringify(
        excludePatterns
      )}`
    );
    core.info(`Max PR Reviews: ${maxPrReviews}`);
    core.info(`Cooldown Period: ${cooldownPeriod} minutes`);
    core.info(`Severity threshold: ${core.getInput('severity_threshold') || 'low'}`);
    core.info(`Incremental reviews: ${incrementalReviews ? 'on' : 'off'}`);
    core.info(`Suppress duplicates: ${suppressDuplicates ? 'on' : 'off'}`);
    core.info(`Resolve outdated threads: ${resolveThreads ? 'on' : 'off'}`);

    // Get GitHub token and create octokit client
    const token = core.getInput('github_token', { required: true });
    const octokit = github.getOctokit(token);

    // Check if we should review this PR based on label
    const shouldReview = await shouldReviewPR(
      octokit,
      github.context,
      reviewLabel
    );
    if (!shouldReview) {
      core.info('Skipping review - required label not found on PR');
      return;
    }

    // One read of what we already said on this PR, feeding the review limit,
    // the cooldown and the incremental scope alike.
    const prior = await getPriorReviews(octokit, github.context);

    const reviewCountCheck = checkReviewCount(prior, maxPrReviews);
    if (reviewCountCheck.shouldSkip) {
      core.info(`Skipping review: ${reviewCountCheck.message}`);
      return;
    }

    const cooldownCheck = checkCooldown(prior, cooldownPeriod);
    if (cooldownCheck.shouldSkip) {
      core.info(`Skipping review: ${cooldownCheck.message}`);
      return;
    }

    // Done before the review is posted, so a finding whose line has since been
    // rewritten is folded away rather than sitting next to the new one.
    if (resolveThreads) {
      await resolveOutdatedThreads(octokit, github.context);
    }

    core.info(`Fetching PR diff...`);
    // Get PR diff
    let diff = await getPRDiff(octokit, github.context);
    core.info(`PR diff fetched successfully (${diff.length} characters)`);

    // Log the first 100 characters of the diff for debugging
    core.info(`Diff preview: ${diff.substring(0, 100)}...`);

    // Count the number of files in the diff
    const fileCount = (diff.match(/diff --git/g) || []).length;
    core.info(`Total files in PR diff: ${fileCount}`);

    // Filter excluded files
    if (excludePatterns.length > 0) {
      core.info(
        `=== Excluding files matching patterns: ${excludePatterns.join(
          ', '
        )} ===`
      );
      try {
        diff = filterExcludedFiles(diff, excludePatterns);
        const newFileCount = (diff.match(/diff --git/g) || []).length;
        core.info(
          `Files after exclusion: ${newFileCount} (excluded ${
            fileCount - newFileCount
          })`
        );
      } catch (error) {
        core.warning(`Error during file exclusion: ${error.message}`);
        // Continue with original diff if filtering fails
      }
    }

    // Project conventions from the checked-out workspace, if any were asked for.
    const contextBlock = await loadContextFiles(
      contextFilesInput,
      contextMaxBytes
    );

    // What the latest push added, if this is a re-review and we can work it out.
    const incrementalDiff = incrementalReviews
      ? await getDiffSince(octokit, github.context, prior.latestSha)
      : null;
    const scope = incrementalDiff ? parseCommentableLines(incrementalDiff) : null;
    if (scope) {
      core.info(
        `Incremental scope: ${scope.size} file(s) changed since ${prior.latestSha.slice(0, 7)}.`
      );
    }

    const reported = suppressDuplicates
      ? await loadReportedFindings(octokit, github.context)
      : null;

    core.info(`Inline comments: ${inlineComments ? 'on' : 'off'}`);
    core.info(`Sending diff to OpenRouter API for analysis...`);
    if (reasoningEffort) {
      core.info(`Using reasoning effort: ${reasoningEffort}`);
    }
    // Analyze the diff
    const analysis = await analyzeDiff(
      diff,
      modelId,
      openRouterKey,
      customPrompt,
      reasoningEffort,
      maxTokens,
      contextBlock,
      inlineComments,
      buildPrMetadataBlock(github.context),
      buildReviewScopeBlock({ severityFloor, reported, incrementalDiff })
    );

    // In inline mode the reply is JSON; a model that ignored the contract
    // falls back to being posted as a plain comment rather than discarded.
    let parsed = null;
    if (inlineComments) {
      parsed = coerceReviewObject(analysis);
      if (!parsed || !Array.isArray(parsed.findings)) {
        core.warning(
          'inline_comments is on but the model did not return parseable JSON. Falling back to a single summary comment.'
        );
        parsed = null;
      } else {
        core.info(`Parsed ${parsed.findings.length} finding(s) from the model.`);
      }
    }

    // Enforce the severity floor, the no-repeats rule and the incremental
    // scope on the parsed findings before anything is posted.
    const notes = [];
    if (parsed) {
      const { kept, dropped } = selectFindings(parsed.findings, {
        severityFloor,
        reported,
        scope,
      });
      core.info(
        `Findings: ${kept.length} to post, ${dropped.severity} below the severity floor, ` +
          `${dropped.duplicate} already reported, ${dropped.outOfScope} outside this run's scope.`
      );
      parsed = { ...parsed, findings: kept };

      notes.push(
        scope
          ? `Scope: the ${scope.size} file(s) changed since \`${prior.latestSha.slice(
              0,
              7
            )}\`. Earlier commits were reviewed before and are not revisited.`
          : 'Scope: the full pull request diff.'
      );
      if (severityFloor > 1) {
        const floorName = Object.keys(SEVERITY_RANK).find(
          (name) => SEVERITY_RANK[name] === severityFloor
        );
        notes.push(`Severity floor: \`${floorName}\` and above.`);
      }
      const suppressed =
        dropped.severity + dropped.duplicate + dropped.outOfScope;
      if (suppressed > 0) {
        notes.push(
          `Suppressed ${suppressed} finding(s): ${dropped.duplicate} already reported, ` +
            `${dropped.severity} below the severity floor, ${dropped.outOfScope} outside this scope.`
        );
      }
      notes.push(
        'This is the complete review for these commits — nothing further will be posted for them.'
      );
    }

    // Get minimum_score input (default 75)
    const minimumScore = parseInt(core.getInput('minimum_score') || '75', 10);

    // Extract score and block PR if below minimum
    const score =
      parsed && Number.isFinite(Number(parsed.score))
        ? Number(parsed.score)
        : extractScore(analysis);
    let warningMsg = '';
    if (score !== null) {
      core.info(
        `AI review score: ${score} (minimum required: ${minimumScore})`
      );
      if (score < minimumScore) {
        warningMsg = `> ⚠️ **PR Blocked:** The AI review score for this PR is **${score}**, which is below the required minimum of **${minimumScore}**. Please address the issues below before merging.\n\n`;
        core.setFailed(
          `PR blocked: AI review score (${score}) is below the minimum required (${minimumScore}).`
        );
      }
    } else {
      core.warning('Could not extract score from AI analysis.');
    }

    // Post inline where we can anchor findings to changed lines; otherwise
    // (or if GitHub rejects the review) post the analysis as one comment.
    let posted = false;
    if (parsed) {
      posted = await createInlineReview(
        octokit,
        github.context,
        parsed,
        diff,
        warningMsg,
        notes
      );
    }
    if (!posted) {
      await createPRComment(octokit, github.context, warningMsg + analysis);
    }
    core.info(`PR comment posted successfully`);
  } catch (error) {
    core.error(`Error details: ${JSON.stringify(error)}`);
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();
