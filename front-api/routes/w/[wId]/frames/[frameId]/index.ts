import { workspaceApp } from "@front-api/middlewares/ctx";

import authorizedFiles from "./authorized-files";
import functions from "./functions";
import invocations from "./invocations";
import makeLive from "./make-live";
import permissions from "./permissions";
import source from "./source";

const app = workspaceApp();

app.route("/authorized-files", authorizedFiles);
app.route("/functions", functions);
app.route("/invocations", invocations);
app.route("/make-live", makeLive);
app.route("/permissions", permissions);
app.route("/source", source);

export default app;
