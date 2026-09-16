#include <iostream>
#include <string>
#include <httplib.h>
#include <nlohmann/json.hpp>

// Exemplo com cpp-httplib e nlohmann/json.
// Em producao, use HTTPS e gere um HWID estavel sem expor dados pessoais.
int main() {
    httplib::Client api("http://localhost:3000");
    api.set_connection_timeout(5);
    api.set_read_timeout(5);

    nlohmann::json payload = {
        {"key", "COLE-A-KEY-AQUI"},
        {"productId", "pro"},
        {"hwid", "identificador-estavel-do-computador"}
    };

    auto response = api.Post("/api/client/query", payload.dump(), "application/json");
    if (!response) {
        std::cerr << "Nao foi possivel conectar a API.\n";
        return 1;
    }

    auto body = nlohmann::json::parse(response->body, nullptr, false);
    if (response->status == 200 && body.value("valid", false)) {
        std::cout << "Licenca valida ate " << body.value("expiresAt", "") << "\n";
        return 0;
    }

    std::cerr << "Licenca recusada: " << body.value("reason", "UNKNOWN") << "\n";
    return 2;
}
