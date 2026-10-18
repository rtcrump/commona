import names from "../fixtures/names.txt";
import connectHtml from "../web/onboarding/connect.html";
import connectScript from "./onboarding/script-text.js";
import doneHtml from "../web/onboarding/done.html";
import errorHtml from "../web/onboarding/error.html";
import formCheckHtml from "../web/onboarding/form-check.html";
import guidedHtml from "../web/onboarding/guided.html";
import joinCss from "../web/onboarding/join.css";
import layoutHtml from "../web/onboarding/layout.html";
import sharingHtml from "../web/onboarding/sharing.html";
import statusHtml from "../web/onboarding/status.html";
import welcomeHtml from "../web/onboarding/welcome.html";
import { installNameList } from "./guard/index.js";
import { installTemplates } from "./onboarding/html.js";

installNameList(names);
installTemplates({
  "connect.html": connectHtml,
  "connect.js": connectScript,
  "done.html": doneHtml,
  "error.html": errorHtml,
  "form-check.html": formCheckHtml,
  "guided.html": guidedHtml,
  "join.css": joinCss,
  "layout.html": layoutHtml,
  "sharing.html": sharingHtml,
  "status.html": statusHtml,
  "welcome.html": welcomeHtml,
});
