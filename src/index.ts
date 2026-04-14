export interface Env {
  ISSUE_KV: KVNamespace;
  DISCORD_WEBHOOK_URL: string;
  GITHUB_TOKEN: string;
  MIN_FETCH_INTERVAL_SECONDS?: string;
}

interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string; // added body
  html_url: string;
  state: string;
  comments: number;
  user: {
    login: string;
    avatar_url: string;
  };
  created_at: string;
  // If this field exists the item is a Pull Request, not a plain issue
  pull_request?: unknown;
}

/**
 * Parses the issue body to extract key sections based on expected headers.
 */
function parseIssueBody(body: string | null): { [key: string]: string } {
  if (!body) return {};

  const sections: { [key: string]: string } = {};
  // Common headers in the templates
  const headers = [
    "Version",
    "Describe the bug",
    "Describe the solution",
    "변경사항",
    "테스트 방법",
    "참고 사항",
    "Additional context"
  ];

  const lines = body.split("\n");
  let currentHeader = "";

  for (const line of lines) {
    const trimmedLine = line.trim();
    
    // Check if the line is a header (starts with ### or matches our key headers)
    const headerMatch = headers.find(h => trimmedLine.includes(h));
    if (headerMatch && (trimmedLine.startsWith("#") || trimmedLine.startsWith("**"))) {
      currentHeader = headerMatch;
      sections[currentHeader] = "";
      continue;
    }

    if (currentHeader && trimmedLine) {
      // Append text to the current section, limiting length for Discord
      if (sections[currentHeader].length < 300) {
        sections[currentHeader] += (sections[currentHeader] ? "\n" : "") + trimmedLine;
      }
    }
  }

  return sections;
}

export default {
  async scheduled(event: ScheduledEvent | null, env: Env, ctx: ExecutionContext): Promise<void> {
    const REPO = "oss2026hnu/reposcore-cs";
    const GITHUB_API_URL = `https://api.github.com/repos/${REPO}/issues?state=all&per_page=10&sort=created&direction=desc`;

    try {
      // Respect a minimum interval between actual GitHub requests to help avoid rate limit bursts.
      const minIntervalMs = env.MIN_FETCH_INTERVAL_SECONDS ? Number(env.MIN_FETCH_INTERVAL_SECONDS) * 1000 : 5 * 60 * 1000; // default 5 minutes
      const lastFetch = await env.ISSUE_KV.get("LAST_FETCH_TS");
      if (lastFetch) {
        const lastTs = Number(lastFetch);
        if (!Number.isNaN(lastTs) && Date.now() - lastTs < minIntervalMs) {
          console.log(`Skipping GitHub fetch; last fetch ${Date.now() - lastTs}ms ago.`);
          return;
        }
      }

      // Use conditional requests with ETag to avoid counting against rate limits when unchanged.
      const headers: Record<string, string> = {
        "User-Agent": "Cloudflare-Worker-OSS-Alarm-TS",
        "Accept": "application/vnd.github.v3+json",
        "Authorization": `Bearer ${env.GITHUB_TOKEN}`
      };
      const savedEtag = await env.ISSUE_KV.get("ISSUES_ETAG");
      if (savedEtag) headers["If-None-Match"] = savedEtag;

      const response = await fetch(GITHUB_API_URL, { headers });

      // 304 Not Modified => nothing changed; update last fetch timestamp and exit without processing.
      if (response.status === 304) {
        console.log("GitHub: Not modified (304). Skipping processing.");
        await env.ISSUE_KV.put("LAST_FETCH_TS", Date.now().toString());
        return;
      }

      if (!response.ok) {
        throw new Error(`GitHub API returned ${response.status}: ${await response.text()}`);
      }

      const newEtag = response.headers.get("etag");
      if (newEtag) {
        await env.ISSUE_KV.put("ISSUES_ETAG", newEtag);
      }

      // Update last fetch timestamp for successful fetch
      await env.ISSUE_KV.put("LAST_FETCH_TS", Date.now().toString());

      const issues = (await response.json()) as GitHubIssue[];
      if (!issues || issues.length === 0) {
        console.log("No issues found in the repository.");
        return;
      }

      // GitHub의 /issues 엔드포인트는 Pull Request도 함께 반환합니다.
      // `pull_request` 필드가 있으면 PR이므로 제외하고 첫 번째 Issue를 선택합니다.
      const nonPrIssues = issues.filter(i => !(i as any).pull_request);
      if (!nonPrIssues || nonPrIssues.length === 0) {
        console.log("No issues (excluding PRs) found in the recent items.");
        return;
      }

      const latestIssue = nonPrIssues[0];
      const latestIssueId = latestIssue.id.toString();

      const lastCheckedId = await env.ISSUE_KV.get("LAST_ISSUE_ID");

      if (lastCheckedId !== latestIssueId) {
        console.log(`New issue detected: ${latestIssue.title} (ID: ${latestIssueId})`);

        const parsedData = parseIssueBody(latestIssue.body);
        const fields = Object.entries(parsedData).map(([name, value]) => ({
          name,
          value: value.length > 200 ? value.substring(0, 197) + "..." : value,
          inline: false
        }));

        // Always add the state field
        fields.push({
          name: "상태",
          value: latestIssue.state,
          inline: true
        });

        const discordPayload = {
          content: "@here", // added mention
          username: latestIssue.user.login,
          avatar_url: latestIssue.user.avatar_url,
          embeds: [{
            title: `${latestIssue.title}`,
            url: latestIssue.html_url,
            color: 0xE67E22,
            description: `**이슈 번호:** > #${latestIssue.number}\n\n----\n${latestIssue.body ? latestIssue.body.substring(0, 200) + (latestIssue.body.length > 200 ? "..." : "") : "설명 없음"}`,
            fields: fields,
            footer: { 
              text: `Repo: ${REPO}`,
              icon_url: "https://github.githubassets.com/favicons/favicon.svg"
            },
            timestamp: new Date(latestIssue.created_at).toISOString()
          }],
          components: [
            {
              type: 1, // Action Row
              components: [
                {
                  type: 2, // Button
                  label: "이슈 바로가기",
                  style: 5, // Link
                  url: latestIssue.html_url
                }
              ]
            }
          ]
        };

        const discordResponse = await fetch(env.DISCORD_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(discordPayload)
        });

        if (!discordResponse.ok) {
          console.error("Discord Webhook failed:", await discordResponse.text());
        } else {
          await env.ISSUE_KV.put("LAST_ISSUE_ID", latestIssueId);
          console.log("Successfully notified Discord and updated KV.");

          // If the issue already has one or more comments, send an additional '<선점됨>' message
          if (latestIssue.comments && latestIssue.comments >= 1) {
            const reservePayload = {
              username: latestIssue.user.login,
              avatar_url: latestIssue.user.avatar_url,
              embeds: [{
                title: "[선점됨]",
                description: `이슈 #${latestIssue.number} - ${latestIssue.title}`,
                url: latestIssue.html_url,
                color: 0x95A5A6,
                timestamp: new Date().toISOString()
              }]
            };

            const reserveResponse = await fetch(env.DISCORD_WEBHOOK_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(reservePayload)
            });

            if (!reserveResponse.ok) {
              console.error("Reserve message failed:", await reserveResponse.text());
            } else {
              console.log("Sent embed '[선점됨]' message because issue has comments.");
            }
          }
        }
      } else {
        console.log("No new issues since last check.");
      }
    } catch (error) {
      console.error("Error in scheduled worker:", error);
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    await this.scheduled(null, env, ctx);
    return new Response("Manual check (TS) triggered and completed.", { status: 200 });
  }
};
