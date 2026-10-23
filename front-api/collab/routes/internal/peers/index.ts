import { collabApp } from "@front-api/collab/middlewares/ctx";

import saveState from "./save_state";
import snapshot from "./snapshot";
import writer from "./writer";

// Mounted at /internal/peers on the collab server: only other collab servers call these routes.
const app = collabApp();

app.route("/snapshot", snapshot);
app.route("/writer", writer);
app.route("/save_state", saveState);

export default app;
