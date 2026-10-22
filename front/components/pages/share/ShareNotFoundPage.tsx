import Custom404 from "@app/components/pages/Custom404";
import CustomErrorPage from "@app/components/pages/CustomErrorPage";
import config from "@app/lib/api/config";
import { DUST_HAS_SESSION, hasSessionIndicator } from "@app/lib/cookies";
import { LogIn01 } from "@dust-tt/sparkle";
import { useLingui } from "@lingui/react/macro";
import { useCookies } from "react-cookie";

export function buildLoginUrl() {
  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return `${config.getApiBaseUrl()}/api/workos/login?returnTo=${encodeURIComponent(returnTo)}`;
}

/**
 * A share hidden from this viewer and a token that never existed must render the same page, so the
 * sign-in affordance has to live on the 404 rather than replace it: a logged-out workspace member
 * reaches a share only by signing in from here.
 */
export function ShareNotFoundPage() {
  const { t } = useLingui();
  const [cookies] = useCookies([DUST_HAS_SESSION]);

  return hasSessionIndicator(cookies[DUST_HAS_SESSION]) ? (
    <Custom404 />
  ) : (
    <CustomErrorPage
      title={t`404: Page not found`}
      description={t`If you have access to this page, sign in to open it.`}
      href={buildLoginUrl()}
      label={t`Sign in`}
      icon={LogIn01}
    />
  );
}
