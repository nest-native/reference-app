export interface CurrentUserContext {
  id: number;
  email?: string;
}

export interface CurrentOrganizationContext {
  id: number;
  slug?: string;
}

export interface AuthContext {
  user: CurrentUserContext;
  organization: CurrentOrganizationContext | null;
}

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Connection address (populated by the HTTP platform). NOT a proxy header. */
  ip?: string;
  socket?: { remoteAddress?: string };
  authContext?: AuthContext;
}
