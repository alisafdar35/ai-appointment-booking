import type { AuthResponse, UserDto } from '@appt/shared';

/**
 * A deliberately small HTTP client for driving the API in tests.
 *
 * It is `fetch` plus a cookie jar, and nothing else. The jar matters because
 * the real client is a browser: sessions live in httpOnly cookies, the refresh
 * cookie is scoped to /api/auth, and logout works by expiring them. Testing
 * those behaviours needs something that stores, scopes and expires cookies the
 * way a browser does — hand-copying tokens between requests would test a
 * different system.
 */

export interface StoredCookie {
  name: string;
  value: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string | undefined;
  /** Max-Age in seconds, when the server sent one. */
  maxAge: number | undefined;
}

export interface ApiResponse<T = unknown> {
  status: number;
  headers: Headers;
  /** Parsed JSON, or the raw text when the body is not JSON. */
  body: T;
  /** Raw Set-Cookie header values, for asserting on attributes. */
  setCookies: string[];
}

export interface RequestOptions {
  /** Serialised as JSON with the matching Content-Type. */
  json?: unknown;
  /** Sent verbatim. For malformed or oversized payloads. */
  rawBody?: string;
  headers?: Record<string, string>;
  /** Sends `Authorization: Bearer <token>` in addition to any cookies. */
  bearer?: string;
  /** Skip the cookie jar entirely for this request. */
  withoutCookies?: boolean;
}

function parseSetCookie(header: string): StoredCookie {
  const [pair = '', ...attributes] = header.split(';').map((part) => part.trim());
  const separator = pair.indexOf('=');
  const cookie: StoredCookie = {
    name: pair.slice(0, separator),
    value: pair.slice(separator + 1),
    path: '/',
    httpOnly: false,
    secure: false,
    sameSite: undefined,
    maxAge: undefined,
  };
  for (const attribute of attributes) {
    const [key = '', value = ''] = attribute.split('=');
    switch (key.toLowerCase()) {
      case 'path':
        cookie.path = value;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'secure':
        cookie.secure = true;
        break;
      case 'samesite':
        cookie.sameSite = value;
        break;
      case 'max-age':
        cookie.maxAge = Number(value);
        break;
      case 'expires':
        // An Expires in the past is how Express clears a cookie.
        if (Date.parse(value) <= Date.now()) cookie.maxAge = 0;
        break;
    }
  }
  return cookie;
}

const pathMatches = (cookiePath: string, requestPath: string) =>
  requestPath === cookiePath || requestPath.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`);

export class ApiClient {
  private readonly jar = new Map<string, StoredCookie>();

  /** Populated by `login`/`signup`, for tests that need ids or the access token. */
  user: UserDto | undefined;
  accessToken: string | undefined;

  constructor(readonly baseUrl: string) {}

  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...options.headers };
    let body: string | undefined;
    if (options.rawBody !== undefined) {
      body = options.rawBody;
      headers['content-type'] ??= 'application/json';
    } else if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers['content-type'] = 'application/json';
    }
    if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
    if (!options.withoutCookies) {
      const cookieHeader = this.cookieHeaderFor(path.split('?')[0]!);
      if (cookieHeader) headers.cookie = cookieHeader;
    }

    const res = await fetch(`${this.baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    const setCookies = res.headers.getSetCookie();
    this.storeCookies(setCookies);

    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON (e.g. an HTML error page). Tests assert on this deliberately.
    }
    return { status: res.status, headers: res.headers, body: parsed as T, setCookies };
  }

  get<T = unknown>(path: string, options?: RequestOptions) {
    return this.request<T>('GET', path, options);
  }

  post<T = unknown>(path: string, json?: unknown, options: RequestOptions = {}) {
    return this.request<T>('POST', path, { ...options, ...(json !== undefined ? { json } : {}) });
  }

  async login(email: string, password: string, businessSlug?: string): Promise<ApiResponse<AuthResponse>> {
    const res = await this.post<AuthResponse>('/api/auth/login', { email, password, businessSlug });
    if (res.status === 200) this.adopt(res.body);
    return res;
  }

  /** Remember who this client is, after a successful login or signup. */
  adopt(auth: AuthResponse): void {
    this.user = auth.user;
    this.accessToken = auth.accessToken;
  }

  cookie(name: string): StoredCookie | undefined {
    return this.jar.get(name);
  }

  /** Plant a cookie directly, to model a stolen or tampered one. */
  setCookie(name: string, value: string, path = '/'): void {
    this.jar.set(name, { name, value, path, httpOnly: true, secure: false, sameSite: undefined, maxAge: undefined });
  }

  /** A second "browser" that starts with a copy of this one's cookies. */
  fork(): ApiClient {
    const copy = new ApiClient(this.baseUrl);
    for (const [name, cookie] of this.jar) copy.jar.set(name, { ...cookie });
    copy.user = this.user;
    copy.accessToken = this.accessToken;
    return copy;
  }

  private cookieHeaderFor(requestPath: string): string {
    return [...this.jar.values()]
      .filter((c) => pathMatches(c.path, requestPath))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  private storeCookies(setCookies: string[]): void {
    for (const header of setCookies) {
      const cookie = parseSetCookie(header);
      if (cookie.value === '' || cookie.maxAge === 0) this.jar.delete(cookie.name);
      else this.jar.set(cookie.name, cookie);
    }
  }
}
