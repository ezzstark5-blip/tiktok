cmake_minimum_required(VERSION 3.20)
project(keyforge_client LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)

include(FetchContent)
FetchContent_Declare(httplib GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git GIT_TAG v0.22.0)
FetchContent_Declare(json GIT_REPOSITORY https://github.com/nlohmann/json.git GIT_TAG v3.12.0)
FetchContent_MakeAvailable(httplib json)

add_executable(keyforge_client cpp-client.cpp)
target_link_libraries(keyforge_client PRIVATE httplib::httplib nlohmann_json::nlohmann_json)

