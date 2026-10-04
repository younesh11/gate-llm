import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent, fetch, type RequestInit } from 'undici';
import { HttpError } from './store.ts';

const privateV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]
] as const) privateV4.addSubnet(address, prefix, 'ipv4');
const mappedV4 = new BlockList(); mappedV4.addSubnet('::ffff:0:0', 96, 'ipv6');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
const specialV6 = new BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) specialV6.addSubnet(address, prefix, 'ipv6');
const metadata = new BlockList();
metadata.addSubnet('169.254.0.0', 16, 'ipv4');
metadata.addAddress('100.100.100.200', 'ipv4');
metadata.addAddress('168.63.129.16', 'ipv4');
metadata.addAddress('fd00:ec2::254', 'ipv6');
const addressText = (address: string) => address.toLowerCase().replace(/^\[|\]$/g, '');

export function isPrivateAddress(address: string) {
  const value = addressText(address), family = isIP(value);
  if (family === 4) return privateV4.check(value, 'ipv4');
  if (family !== 6) return true;
  // BlockList also recognizes hexadecimal and dotted IPv4-mapped IPv6 forms.
  if (mappedV4.check(value, 'ipv6')) return privateV4.check(value, 'ipv6');
  return !globalV6.check(value, 'ipv6') || specialV6.check(value, 'ipv6');
}
function checkAddress(address: string, allowPrivate: boolean) {
  const value = addressText(address), family = isIP(value);
  if (!family) throw new HttpError(400, 'Provider hostname returned an invalid address.');
  if (metadata.check(value, family === 4 ? 'ipv4' : 'ipv6')) throw new HttpError(400, 'Cloud metadata endpoints cannot be used as providers.');
  if (!allowPrivate && isPrivateAddress(value)) throw new HttpError(400, 'Private upstreams require ALLOW_PRIVATE_UPSTREAMS=true.');
}
function parseUpstream(url: string, allowPrivate: boolean) {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new HttpError(400, 'Enter an absolute provider URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new HttpError(400, 'Use an HTTP(S) URL without credentials, query strings or fragments.');
  const hostname = addressText(parsed.hostname).replace(/\.$/, '');
  if (['metadata', 'metadata.google.internal'].includes(hostname)) throw new HttpError(400, 'Cloud metadata endpoints cannot be used as providers.');
  if (!allowPrivate && parsed.protocol !== 'https:') throw new HttpError(400, 'Public upstreams must use HTTPS. Set ALLOW_PRIVATE_UPSTREAMS for a trusted local model.');
  if (isIP(hostname)) checkAddress(hostname, allowPrivate);
  return parsed;
}
export type ResolveAddresses = (hostname: string) => Promise<LookupAddress[]>;
const systemLookup: ResolveAddresses = hostname => lookup(hostname, { all: true });
async function resolveChecked(hostname: string, allowPrivate: boolean, resolve: ResolveAddresses) {
  let addresses: LookupAddress[];
  try { addresses = await resolve(hostname); } catch { throw new HttpError(400, 'Provider hostname could not be resolved.'); }
  if (!addresses.length) throw new HttpError(400, 'Provider hostname could not be resolved.');
  for (const row of addresses) {
    if (isIP(row.address) !== row.family) throw new HttpError(400, 'Provider hostname returned an invalid address.');
    checkAddress(row.address, allowPrivate);
  }
  return addresses;
}
export async function validateUpstream(url: string, allowPrivate: boolean, resolve: ResolveAddresses = systemLookup) {
  const parsed = parseUpstream(url, allowPrivate), hostname = addressText(parsed.hostname);
  if (!isIP(hostname)) await resolveChecked(hostname, allowPrivate, resolve);
  return parsed.toString().replace(/\/$/, '');
}

export type UpstreamFetch = (url: string, init?: RequestInit) => ReturnType<typeof fetch>;
export function createUpstreamClient(allowPrivate: boolean, resolve: ResolveAddresses = systemLookup) {
  // The socket uses these exact checked DNS results. A second, unchecked lookup
  // must never occur between validation and connecting (DNS rebinding).
  const checkedLookup: LookupFunction = (hostname, options, callback) => {
    void resolveChecked(hostname, allowPrivate, resolve).then(addresses => {
      const family = Number(options.family) || 0;
      const eligible = family ? addresses.filter(row => row.family === family) : addresses;
      if (!eligible.length) { callback(new Error('Provider address family unavailable.'), ''); return; }
      if (options.all) callback(null, eligible);
      else callback(null, eligible[0].address, eligible[0].family);
    }, () => callback(new Error('Provider address rejected by upstream policy.'), ''));
  };
  const dispatcher = new Agent({ connect: { lookup: checkedLookup, timeout: 5000 }, connections: 16 });
  const request: UpstreamFetch = async (url, init) => {
    const parsed = parseUpstream(url, allowPrivate);
    return fetch(parsed, { ...init, dispatcher, redirect: 'error' });
  };
  return { fetch: request, close: () => dispatcher.destroy() };
}
