// netlify/functions/client-config.js
// White-label multi-tenant client config.
// Reads the request (Host subdomain, or `x-client-subdomain` header)
// and returns the matching client's PUBLIC config fields
// (companyName, logo, primaryColor, subdomain, crmUrl,
// ghlWebhookUrl). Resolution lives in lib-client.js, shared with
// cc-data.js so both functions agree on which client a request
// belongs to.
//
// SECURITY: secrets (HighLevel tokens, data provider keys) are NEVER in
// the client JSON files and NEVER returned by this function. They live
// only in Netlify env vars, referenced by name in the config files.
//
// Mapping:
//   leadmachineapp.com / www.leadmachineapp.com / app.leadmachineapp.com -> troy
//   {subdomain}.leadmachineapp.com -> clients/{subdomain}.json
//   localhost / *.netlify.app (dev + previews) -> troy
//   unknown subdomain / unknown host -> NEUTRAL default
//     (clients/_default.json: "Command Center", no logo, no Troy
//     numbers, no Troy location). NEVER Troy — an unknown subdomain
//     must not receive Troy's branding (fixed Nov 11; the old code
//     fell back to Troy for any unknown subdomain).
'use strict';

const { resolveClient, publicConfig } = require('./lib-client');

exports.handler = async (event) => {
  const { cfg } = resolveClient(event);
  if (!cfg) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'no client config available' }),
    };
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
    },
    body: JSON.stringify(publicConfig(cfg)),
  };
};
