import { collabApp } from "@front-api/collab/middlewares/ctx";

import agentActivity from "./agent_activity";
import edit from "./edit";
import read from "./read";
import write from "./write";

// Mounted at /internal/documents on the collab server.
const app = collabApp();

app.route("/read", read);
app.route("/write", write);
app.route("/edit", edit);
app.route("/agent_activity", agentActivity);

export default app;
