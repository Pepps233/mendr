export type AgentName = "claude" | "codex";

export type Issue = {
  title: string;
  file: string;
  line: number;
  severity: string;
  description: string;
};

export type FixIssueStatus = "fixed" | "failed";

export type FixIssueResult = {
  title: string;
  fingerprint: string;
  status: FixIssueStatus;
  sha?: string;
  summary: string;
};

export type ReviewContext = {
  repo: string;
  pr: string;
  model: string;
  diff: string;
  reviewMarkdown: string;
  reportMarkdown: string;
};

export type AgentDriver = {
  review(ctx: ReviewContext): Promise<Issue[]>;
  fix(issues: Issue[], ctx: ReviewContext): Promise<FixIssueResult[]>;
};

export type AgentInvocation = {
  command: string;
  args: string[];
};

export class AgentParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentParseError";
  }
}

export function extractJsonValue(text: string): unknown {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    throw new AgentParseError("Agent output was empty.");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue through fenced and prose-wrapped JSON extraction.
  }

  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const candidate = match[1]?.trim();

    if (!candidate) {
      continue;
    }

    try {
      return JSON.parse(candidate);
    } catch {
      // Try later fenced blocks before falling back to bracket scanning.
    }
  }

  const candidate = findFirstJsonCandidate(trimmed);

  if (candidate) {
    try {
      return JSON.parse(candidate);
    } catch {
      throw new AgentParseError("Agent output contained malformed JSON.");
    }
  }

  throw new AgentParseError("Agent output did not contain JSON.");
}

export function parseIssueArrayFromText(text: string): Issue[] {
  const value = extractJsonValue(text);

  if (!Array.isArray(value)) {
    throw new AgentParseError("Agent JSON payload must be an issue array.");
  }

  return value.map(parseIssue);
}

export function parseFixIssueResultArrayFromText(text: string): FixIssueResult[] {
  const value = extractJsonValue(text);

  if (!Array.isArray(value)) {
    throw new AgentParseError("Agent JSON payload must be a fix result array.");
  }

  return value.map(parseFixIssueResult);
}

export function issueFingerprint(issue: Issue): string {
  return [
    normalizeFingerprintPart(issue.title),
    normalizeFingerprintPart(issue.file),
    String(issue.line),
    normalizeFingerprintPart(issue.description)
  ].join("|");
}

export function dedupeIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  const deduped: Issue[] = [];

  for (const issue of issues) {
    const fingerprint = issueFingerprint(issue);

    if (seen.has(fingerprint)) {
      continue;
    }

    seen.add(fingerprint);
    deduped.push(issue);
  }

  return deduped;
}

function parseIssue(value: unknown): Issue {
  if (!isRecord(value)) {
    throw new AgentParseError("Agent issue must be an object.");
  }

  const { title, file, line, severity, description } = value;

  if (
    typeof title !== "string" ||
    typeof file !== "string" ||
    typeof line !== "number" ||
    !Number.isInteger(line) ||
    typeof severity !== "string" ||
    typeof description !== "string"
  ) {
    throw new AgentParseError("Agent issue has an invalid schema.");
  }

  return {
    title,
    file,
    line,
    severity,
    description
  };
}

function parseFixIssueResult(value: unknown): FixIssueResult {
  if (!isRecord(value)) {
    throw new AgentParseError("Agent fix result must be an object.");
  }

  const { title, fingerprint, status, summary } = value;
  const sha = readOptionalString(value, "sha") ?? readOptionalString(value, "commitSha");

  if (
    typeof title !== "string" ||
    typeof fingerprint !== "string" ||
    (status !== "fixed" && status !== "failed") ||
    typeof summary !== "string"
  ) {
    throw new AgentParseError("Agent fix result has an invalid schema.");
  }

  return {
    title,
    fingerprint,
    status,
    sha,
    summary
  };
}

function readOptionalString(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];

  return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
}

function normalizeFingerprintPart(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function findFirstJsonCandidate(text: string): string | undefined {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char !== "[" && char !== "{") {
      continue;
    }

    const end = findJsonEnd(text, index, char === "[" ? "]" : "}");

    if (end !== undefined) {
      return text.slice(index, end + 1);
    }
  }

  return undefined;
}

function findJsonEnd(text: string, start: number, expectedClose: "]" | "}"): number | undefined {
  const stack: string[] = [expectedClose];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }

      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "[") {
      stack.push("]");
      continue;
    }

    if (char === "{") {
      stack.push("}");
      continue;
    }

    if (char === "]" || char === "}") {
      if (stack.at(-1) !== char) {
        return undefined;
      }

      stack.pop();

      if (stack.length === 0) {
        return index;
      }
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
