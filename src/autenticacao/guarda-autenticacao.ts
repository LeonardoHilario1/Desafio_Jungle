import { Injectable, type CanActivate } from '@nestjs/common';

/**
 * ponto de extensão da autenticação. por enquanto não bloqueia nada (ficou fora do escopo).
 * a ideia, descrita no ARCHITECTURE.md, é validar aqui o token de um IdP externo
 * (assinatura via JWKS, issuer, audience e expiração) e tirar dele qual é o provedor.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
