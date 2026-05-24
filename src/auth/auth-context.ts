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
  authContext?: AuthContext;
}
