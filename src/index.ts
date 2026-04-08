export interface Env {
  ISSUE_KV: KVNamespace;
  DISCORD_WEBHOOK_URL: string;
}

interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  html_url: string;
  state: string;
  user: {
    login: string;
  };
  created_at: string;
}

export default {
  async scheduled(event: ScheduledEvent | null, env: Env, ctx: ExecutionContext): Promise<void> {
    const REPO = "oss2026hnu/reposcore-cs";
    const GITHUB_API_URL = `https://api.github.com/repos/${REPO}/issues?state=all&per_page=1&sort=created&direction=desc`;

    try {
      const response = await fetch(GITHUB_API_URL, {
        headers: {
          "User-Agent": "Cloudflare-Worker-OSS-Alarm-TS",
          "Accept": "application/vnd.github.v3+json"
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

        const discordPayload = {
          embeds: [{
            title: `🚨 새로운 이슈 등록: ${latestIssue.title}`,
            url: latestIssue.html_url,
            color: 0xE67E22,
            description: `**작성자:** ${latestIssue.user.login}\n**이슈 번호:** #${latestIssue.number}`,
            fields: [
              {
                name: "상태",
                value: latestIssue.state,
                inline: true
              }
            ],
            footer: { 
              text: `Repo: ${REPO}`,
              icon_url: "https://github.githubassets.com/favicons/favicon.svg"
            },
            timestamp: new Date(latestIssue.created_at).toISOString()
          }]
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
