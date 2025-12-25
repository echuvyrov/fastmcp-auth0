import type { IncomingMessage } from "http";
import { ApiClient, VerifyAccessTokenError, InvalidRequestError, getToken } from "@auth0/auth0-api-js";
import {
  InsufficientScopeError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { FastMCPAuthSession } from "./types.js";

const PORT = parseInt(process.env.PORT ?? "3001", 10);
// MCP_SERVER_URL should be set to your deployment URL when deployed
// For local development, it defaults to http://localhost:PORT
// For ngrok, set it to your ngrok URL (e.g., https://abc123.ngrok.io)
// When deployed, set this to your production URL
const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? `http://localhost:${PORT}`;
const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN as string;
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE as string;

const apiClient = new ApiClient({
  domain: AUTH0_DOMAIN,
  audience: AUTH0_AUDIENCE,
});

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Get the base URL for the MCP server, handling ngrok and proxy scenarios
 */
function getBaseUrl(request: IncomingMessage): string {
  // If MCP_SERVER_URL is explicitly set (e.g., ngrok URL), use it
  if (process.env.MCP_SERVER_URL) {
    return MCP_SERVER_URL;
  }
  
  // Otherwise, try to detect from request headers (for ngrok/proxy scenarios)
  const host = request.headers.host || request.headers["x-forwarded-host"];
  if (host) {
    const protocol = request.headers["x-forwarded-proto"] === "https" ? "https" : 
                     request.headers["x-forwarded-proto"] === "http" ? "http" :
                     MCP_SERVER_URL.startsWith("https") ? "https" : "http";
    return `${protocol}://${host}`;
  }
  
  // Fallback to configured MCP_SERVER_URL
  return MCP_SERVER_URL;
}

export const authenticate = async (
  request: IncomingMessage
): Promise<FastMCPAuthSession> => {
  // Get the base URL (handles ngrok/proxy scenarios) - calculate once for use in both try and catch
  const baseUrl = getBaseUrl(request);
  
  try {
    // Extract request URL to check if this is a discovery endpoint
    const requestUrl = request.url || "";
    const isDiscoveryEndpoint = requestUrl.includes("/.well-known/");
    
    // Extract Authorization header - Node.js IncomingMessage.headers uses lowercase keys
    // Headers can be string or string[], so we need to handle both cases
    const authHeaderRaw = request.headers.authorization || request.headers.Authorization;
    const authHeader = Array.isArray(authHeaderRaw) ? authHeaderRaw[0] : authHeaderRaw;
    
    // Check if token exists before trying to extract
    if (!authHeader || typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
      // If this is a discovery endpoint, this is expected - but FastMCP shouldn't call authenticate for these
      if (isDiscoveryEndpoint) {
        console.warn(`[Auth] Discovery endpoint ${requestUrl} called authenticate - this may indicate a FastMCP routing issue`);
      } else {
        // This is expected for initial connection attempts - client will get 401 and authenticate
        // Log at info level since this is normal OAuth flow behavior
        console.log(`[Auth] No Bearer token in initial request to ${requestUrl} - returning 401 with WWW-Authenticate header`);
      }
      throw new InvalidRequestError("No Bearer token found in request");
    }
    
    // Extract token from Bearer header
    const accessToken = authHeader.substring(7).trim();
    
    // Try getToken as a validation step, but use our extracted token
    // This helps catch any format issues early
    try {
      getToken(request.headers);
    } catch (error) {
      // getToken may throw for various reasons, but we already have the token extracted
      // Log a warning if it's not an InvalidRequestError (which we already handled)
      if (!(error instanceof InvalidRequestError)) {
        console.warn(`[Auth] getToken validation failed, but token extracted successfully:`, error);
      }
    }
    const decoded = await apiClient.verifyAccessToken({
      accessToken,
    });

    if (!isNonEmptyString(decoded.sub)) {
      throw new InvalidTokenError(
        "Token is missing required subject (sub) claim"
      );
    }

    let clientId: string | null = null;
    if (isNonEmptyString(decoded.client_id)) {
      clientId = decoded.client_id;
    } else if (isNonEmptyString(decoded.azp)) {
      clientId = decoded.azp;
    }

    if (!clientId) {
      throw new InvalidTokenError(
        "Token is missing required client identification (client_id or azp claim)."
      );
    }

    const token = {
      token: accessToken,
      clientId,
      scopes:
        typeof decoded.scope === "string"
          ? decoded.scope.split(" ").filter(Boolean)
          : [],
      ...(decoded.exp && { expiresAt: decoded.exp }),
      extra: {
        sub: decoded.sub,
        ...(isNonEmptyString(decoded.client_id) && {
          client_id: decoded.client_id,
        }),
        ...(isNonEmptyString(decoded.azp) && { azp: decoded.azp }),
        ...(isNonEmptyString(decoded.name) && { name: decoded.name }),
        ...(isNonEmptyString(decoded.email) && { email: decoded.email }),
      },
    } satisfies FastMCPAuthSession;

    return token;
  } catch (error) {
    console.error(error);
    if (
      error instanceof InvalidRequestError ||
      error instanceof VerifyAccessTokenError ||
      error instanceof InvalidTokenError
    ) {
      /**
       * WWW-Authenticate header is used for 401 responses as per spec.
       * Use the base URL (which may be from ngrok) for resource metadata
       */
      const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(
        new URL(baseUrl)
      );
      const wwwAuthValue = `Bearer error="invalid_token", error_description="${
        error.message
      }", resource_metadata="${resourceMetadataUrl}"`;
      
      // Log the response details for debugging
      console.log(`[Auth] Returning 401 with WWW-Authenticate header`);
      console.log(`[Auth] Resource metadata URL: ${resourceMetadataUrl}`);
      console.log(`[Auth] WWW-Authenticate value: ${wwwAuthValue}`);
      
      throw new Response(null, {
        status: 401,
        statusText: "Unauthorized",
        headers: {
          "WWW-Authenticate": wwwAuthValue,
        },
      });
    } else if (error instanceof InsufficientScopeError) {
      throw new Response(null, {
        status: 403,
        statusText: "Forbidden",
      });
    } else {
      throw new Response(null, {
        status: 500,
        statusText: "Internal Server Error",
      });
    }
  }
};
