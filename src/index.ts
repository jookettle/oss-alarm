export interface Env {
  ISSUE_KV: KVNamespace;
  DISCORD_WEBHOOK_URL: string;
  GITHUB_TOKEN: string;
}

interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string; // added body
  html_url: string;
  state: string;
  user: {
    login: string;
    avatar_url: string;
  };
  created_at: string;
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
    "🧪 테스트 방법",
    "💬 참고 사항",
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
    const GITHUB_API_URL = `https://api.github.com/repos/${REPO}/issues?state=all&per_page=1&sort=created&direction=desc`;

    try {
      const response = await fetch(GITHUB_API_URL, {
        headers: {
          "User-Agent": "Cloudflare-Worker-OSS-Alarm-TS",
          "Accept": "application/vnd.github.v3+json",
          "Authorization": `Bearer ${env.GITHUB_TOKEN}`
        }
      });

      if (!response.ok) {
        throw new Error(`GitHub API returned ${response.status}: ${await response.text()}`);
      }

      const issues = (await response.json()) as GitHubIssue[];
      if (!issues || issues.length === 0) {
        console.log("No issues found in the repository.");
        return;
      }

      const latestIssue = issues[0];
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
            title: `🚨 새로운 이슈 등록: ${latestIssue.title}`,
            url: latestIssue.html_url,
            color: 0xE67E22,
            description: `**작성자:** ${latestIssue.user.login}\n**이슈 번호:** #${latestIssue.number}\n\n${latestIssue.body ? latestIssue.body.substring(0, 200) + (latestIssue.body.length > 200 ? "..." : "") : "설명 없음"}`,
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
