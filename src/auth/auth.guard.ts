import { Injectable, type CanActivate } from '@nestjs/common';

/**
 * Ponto de extensão para autenticação; hoje não restringe nada (fora do escopo do MVP).
 * O desenho previsto está em ARCHITECTURE.md: tokens de um IdP externo validados aqui
 * (assinatura via JWKS, issuer, audience e expiração), com o provedor de jogos
 * identificado pelo token.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
