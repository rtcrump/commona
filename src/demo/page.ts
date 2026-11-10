import { privacySummary, PRIVACY_DETAIL } from "./copy.js";
import { escapeHtml } from "./html.js";
import {
  DEMO_LABEL,
  DEMO_LIMITATION,
  DEMO_MESSAGES,
  DEMO_TASK,
  STORY_STEPS,
  type StoryStep,
} from "./transcript.js";

export interface PageOptions {
  beacon: string;
  analyticsOn: boolean;
}

export function renderDemoPage(options: PageOptions): string {
  const steps = STORY_STEPS.map((step) => renderReplayStep(step)).join("\n");
  const story = renderTranscript();
  return layout({
    title: "Commona demo: two assistants plan a walk",
    beacon: options.beacon,
    includeReplay: true,
    skipHref: "#transcript",
    skipLabel: "Skip to the whole story",
    body: `<p class="banner" role="note">${escapeHtml(DEMO_LABEL)}</p>
<h1>Watch two assistants plan a short walk together</h1>
<p class="lead">Commona is a place where people each bring an assistant, and those assistants can work together. Each person decides what their assistant may share.</p>
<p>${escapeHtml(DEMO_LIMITATION)}</p>
<p>Their task: ${escapeHtml(DEMO_TASK)}</p>
<section class="replay" data-demo-replay data-state="ready" aria-labelledby="replay-heading">
<h2 id="replay-heading">A short replay</h2>
<p>It plays for under twenty seconds. The whole story is already written below, so you do not have to wait.</p>
<button type="button" data-demo-play>Play the story again</button>
<p data-demo-status role="status">The story below is complete. This replay plays it back when the page can move.</p>
<div class="replay-stage" aria-hidden="true">
${steps}
</div>
</section>
<section id="transcript" aria-labelledby="story-heading">
<h2 id="story-heading">The whole story</h2>
<p>Read this straight through. Sharing opens only after the person who owns the note approves it. Then the assistants finish the walk, and each one reports to its own person.</p>
${story}
</section>
<section aria-labelledby="privacy-heading">
<h2 id="privacy-heading">Privacy</h2>
<p>${escapeHtml(privacySummary(options.analyticsOn))}</p>
<p><a href="/demo/privacy">Read the privacy note</a></p>
</section>`,
  });
}

export function renderPrivacyPage(options: PageOptions): string {
  return layout({
    title: "Privacy note for the Commona demo",
    beacon: options.beacon,
    includeReplay: false,
    skipHref: "#content",
    skipLabel: "Skip to the privacy note",
    body: `<p class="banner" role="note">${escapeHtml(DEMO_LABEL)}</p>
<h1>A quiet note about this demo</h1>
<p>${escapeHtml(DEMO_LIMITATION)}</p>
<p>${escapeHtml(privacySummary(options.analyticsOn))}</p>
<p>${escapeHtml(PRIVACY_DETAIL)}</p>
<p><a href="/">Back to the story</a></p>`,
  });
}

export function renderStatusPage(message: string, status: number): string {
  const title = status === 404 ? "That page is not in the demo" : "This demo only shows the story";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/demo/demo.css">
</head>
<body>
<a class="skip" href="/">Back to the story</a>
<main>
<p class="banner" role="note">${escapeHtml(DEMO_LABEL)}</p>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p><a href="/">Read the walk</a></p>
</main>
</body>
</html>`;
}

function layout(input: {
  title: string;
  beacon: string;
  includeReplay: boolean;
  skipHref: string;
  skipLabel: string;
  body: string;
}): string {
  const replay = input.includeReplay ? `<script defer src="/demo/replay.js"></script>` : "";
  const beacon = input.beacon.length > 0 ? `\n${input.beacon}` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="description" content="A scripted Commona demo. Two fictional assistants plan a walk, and each person decides what to share.">
<title>${escapeHtml(input.title)}</title>
<link rel="stylesheet" href="/demo/demo.css">
</head>
<body>
<a class="skip" href="${escapeHtml(input.skipHref)}">${escapeHtml(input.skipLabel)}</a>
<main id="content">
${input.body}
</main>
${replay}${beacon}
</body>
</html>`;
}

function renderReplayStep(step: StoryStep): string {
  const body = step.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("");
  return `<article class="replay-step is-upcoming" data-at="${String(step.atMs)}" data-owner="${step.owner}" data-tone="${step.tone}">
<h3>${escapeHtml(step.heading)}</h3>
${body}
</article>`;
}

function renderTranscript(): string {
  const nia = ownerStory({
    title: "Nia and Lark",
    intro: "Lark is Nia's assistant. Sharing starts closed, so this side is only for Nia.",
    noteHeading: "Lark's note, while Sol cannot see it",
    note: DEMO_MESSAGES.larkOffer,
    hidden: "Sol cannot see Lark's note yet.",
    approval: "Nia approves sharing messages with Sol.",
    approvalBody: "Nia allows messages with Sol. Sol can now read Lark's note. Nia still cannot read Sol's side.",
    sharedHeading: "After Sol approves, Nia can read Reed's note",
    shared: DEMO_MESSAGES.reedOffer,
    reportHeading: "Lark reports to Nia",
    report: DEMO_MESSAGES.reportToNia,
  });
  const sol = ownerStory({
    title: "Sol and Reed",
    intro: "Reed is Sol's assistant. Sharing starts closed, so this side is only for Sol.",
    noteHeading: "Reed's note, while Nia cannot see it",
    note: DEMO_MESSAGES.reedOffer,
    hidden: "Nia cannot see Reed's note yet.",
    approval: "Sol approves sharing messages with Nia.",
    approvalBody: "Sol allows messages with Nia. Both notes are shared.",
    sharedHeading: "After Nia approves, Sol can read Lark's note",
    shared: DEMO_MESSAGES.larkOffer,
    reportHeading: "Reed reports to Sol",
    report: DEMO_MESSAGES.reportToSol,
  });
  return `<div class="story-grid">
${nia}
${sol}
<article class="story-step" data-owner="both" data-tone="agreement">
<h3>The walk is agreed.</h3>
<p>${escapeHtml(DEMO_MESSAGES.agreement)}</p>
<p>One task is finished: one time, one place.</p>
</article>
</div>`;
}

function ownerStory(input: {
  title: string;
  intro: string;
  noteHeading: string;
  note: string;
  hidden: string;
  approval: string;
  approvalBody: string;
  sharedHeading: string;
  shared: string;
  reportHeading: string;
  report: string;
}): string {
  return `<article class="story-step" data-owner="person">
<h3>${escapeHtml(input.title)}</h3>
<p>${escapeHtml(input.intro)}</p>
<h4>${escapeHtml(input.noteHeading)}</h4>
<p>${escapeHtml(input.note)}</p>
<p>${escapeHtml(input.hidden)}</p>
<h4>${escapeHtml(input.approval)}</h4>
<p>${escapeHtml(input.approvalBody)}</p>
<h4>${escapeHtml(input.sharedHeading)}</h4>
<p>${escapeHtml(input.shared)}</p>
<h4>${escapeHtml(input.reportHeading)}</h4>
<p>${escapeHtml(input.report)}</p>
</article>`;
}
