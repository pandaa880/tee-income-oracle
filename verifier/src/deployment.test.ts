// parseDeployment: zod schema of deployments/<cluster>.json (snake_case on disk, camelCase in code).
import { describe, expect, it } from 'vitest';
import { expectBaselineSucceeds, expectThrown, loadDeploymentJson } from './test-fixtures.ts';
import { parseDeployment } from './deployment.ts';

const devnet = (): Record<string, unknown> => loadDeploymentJson() as Record<string, unknown>;
const without = (key: string): Record<string, unknown> => {
  const copy = devnet();
  delete copy[key];
  return copy;
};

describe('parseDeployment', () => {
  it('maps_the_devnet_file_to_camel_case_fields', () => {
    expect(parseDeployment(devnet())).toMatchObject({
      cluster: 'devnet',
      oracleProgram: 'HZyMtqfwXMbqDUwWe9GVSvfZTaXaJZuKAMtJ1i6xwNG8',
      sasProgram: '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG',
      sasSigner: 'HznYLdoTuhm53WjdvNcQBbGT71n9msXgpJcKiya2Moti',
      credential: 'F8K44XAxQ66GWjtpnnTidox81YHcr2VN5ogFofFViCP7',
      schema: '991nZUZr63g1pZJ7VQ8GQWk5fVbP7WsuX7crsY5q8qKV',
    });
  });

  it('maps_both_enclave_records', () => {
    const { enclaves } = parseDeployment(devnet());
    expect(enclaves).toHaveLength(2);
    expect(enclaves[0]).toMatchObject({
      measurementId: 0,
      imageId: '7dd33d974511a825c871f267ebdc6b34fb9cdc2c63210e27a31a8c7cfb96daff',
      attester: '0xc39b71ae1d2bbc0919ee8c1250728a9b2380052b',
      attestationFile: 'devnet/attestation-0.hex',
    });
    expect(enclaves[1]?.attestationFile).toBe('devnet/attestation-1.hex');
  });

  it('keeps_release_and_endpoint_when_a_record_has_them', () => {
    const json = devnet();
    const [first] = json['enclaves'] as Record<string, unknown>[];
    json['enclaves'] = [{ ...first, release: 'v0.3.0', endpoint: 'http://13.127.229.5:1301' }];
    expect(parseDeployment(json).enclaves[0]).toMatchObject({
      release: 'v0.3.0',
      endpoint: 'http://13.127.229.5:1301',
    });
  });

  it('accepts_a_record_without_release_and_endpoint', () => {
    const json = devnet();
    const [first] = json['enclaves'] as Record<string, unknown>[];
    json['enclaves'] = [first];
    expect(parseDeployment(json).enclaves).toHaveLength(1);
  });

  it('accepts_an_empty_enclaves_list', () => {
    expect(parseDeployment({ ...devnet(), enclaves: [] }).enclaves).toEqual([]);
  });

  it.each(['credential', 'schema', 'oracle_program', 'sas_program', 'sas_signer', 'cluster'])(
    'rejects_a_missing_%s',
    (key) => {
      expectBaselineSucceeds(() => parseDeployment(devnet()));
      expectThrown(() => parseDeployment(without(key)), 'deployment_malformed');
    },
  );

  it('rejects_an_address_that_is_not_base58', () => {
    expectThrown(
      () => parseDeployment({ ...devnet(), credential: 'not-an-address-0OIl' }),
      'deployment_malformed',
    );
  });

  it('rejects_an_enclave_record_without_attestation_file', () => {
    const json = devnet();
    const [first] = json['enclaves'] as Record<string, unknown>[];
    const record = { ...first };
    delete record['attestation_file'];
    json['enclaves'] = [record];
    expectThrown(() => parseDeployment(json), 'deployment_malformed');
  });

  it('rejects_a_negative_measurement_id', () => {
    const json = devnet();
    const [first] = json['enclaves'] as Record<string, unknown>[];
    json['enclaves'] = [{ ...first, measurement_id: -1 }];
    expectThrown(() => parseDeployment(json), 'deployment_malformed');
  });

  it.each([null, 'text', 7, []])('rejects_%j_as_deployment_malformed', (value) => {
    expectThrown(() => parseDeployment(value), 'deployment_malformed');
  });
});

const withRecord = (change: Record<string, unknown>): Record<string, unknown> => {
  const json = devnet();
  const [first] = json['enclaves'] as Record<string, unknown>[];
  json['enclaves'] = [{ ...first, ...change }];
  return json;
};

describe('parseDeployment trusts nothing the client already knows (review round 1)', () => {
  it.each(['oracle_program', 'sas_program'])(
    'rejects_a_%s_that_is_not_the_one_the_client_is_built_for',
    (key) => {
      expectBaselineSucceeds(() => parseDeployment(devnet()));
      // A valid address, just not ours.
      const other = '3gJtuaoBxuAMTvphyRx1KXDHKg2FQfbHCWsvQ4rMgSND';
      expectThrown(() => parseDeployment({ ...devnet(), [key]: other }), 'deployment_malformed');
    },
  );

  it.each([
    ['image_id', '7dd33d97'],
    ['image_id', `${'7d'.repeat(31)}7G`],
    ['attester', 'c39b71ae1d2bbc0919ee8c1250728a9b2380052b'],
    ['attester', '0xC39B71AE1D2BBC0919EE8C1250728A9B2380052B'],
    ['release', '0.3.0'],
    ['release', 'v0.3'],
    ['endpoint', '13.127.229.5:1301'],
    ['endpoint', 'ftp://13.127.229.5:1301'],
    ['attestation_file', ''],
  ])('rejects_record_%s_%s', (key, value) => {
    expectBaselineSucceeds(() => parseDeployment(devnet()));
    expectThrown(() => parseDeployment(withRecord({ [key]: value })), 'deployment_malformed');
  });
});
