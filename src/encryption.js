const crypto = require('node:crypto');

const AAD = Buffer.from('api-control-center:v1', 'utf8');

function encryptionKey() {
  const configured = String(process.env.CLIENT_ENCRYPTION_KEY || '').trim();
  if (!configured) throw new Error('CLIENT_ENCRYPTION_KEY nao configurada.');
  const key = Buffer.from(configured, 'base64');
  if (key.length !== 32) throw new Error('CLIENT_ENCRYPTION_KEY deve conter exatamente 32 bytes em Base64.');
  return key;
}

function encryptJson(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    encrypted: true,
    version: 1,
    algorithm: 'AES-256-GCM',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  };
}

function decryptJson(envelope) {
  if (!envelope || envelope.version !== 1 || !envelope.iv || !envelope.tag || !envelope.data) {
    const error = new Error('Envelope criptografado invalido.');
    error.status = 400;
    throw error;
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch {
    const error = new Error('Nao foi possivel autenticar ou descriptografar a requisicao.');
    error.status = 400;
    throw error;
  }
}

module.exports = { encryptJson, decryptJson };
