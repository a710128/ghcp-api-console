/**
 * SSO event log — replaced with structured stdout logging per plan spec.
 * The append-only file log is removed; events are emitted to stdout as JSON.
 */

export interface UserEventFields {
  ssoUser: string;
  email: string;
  role: string;
  ghLogin?: string;
}

/**
 * Emit a user lifecycle event to structured stdout.
 * Replaces the legacy appendFileSync event log.
 */
export function appendUserEvent(action: string, user: UserEventFields): void {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      event: 'sso.user_event',
      action,
      sso_user: user.ssoUser,
      email: user.email,
      role: user.role,
      gh_login: user.ghLogin,
    }),
  );
}
