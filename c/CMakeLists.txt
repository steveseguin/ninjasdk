# VDO.Ninja SDK for C
# Copyright (c) 2025-2026 Steve Seguin
# SPDX-License-Identifier: MPL-2.0
cmake_minimum_required(VERSION 3.16)
project(vdoninja VERSION 0.1.0 LANGUAGES C CXX)

option(VDON_BUILD_SHARED "Build libvdoninja as a shared library" OFF)
option(VDON_BUILD_EXAMPLES "Build examples" ON)
option(VDON_BUILD_TESTS "Build tests" ON)
option(VDON_FETCH_LIBDATACHANNEL "Download and build libdatachannel with FetchContent when it is not installed" ON)
set(VDON_LIBDATACHANNEL_TAG "v0.23.2" CACHE STRING "libdatachannel git tag to fetch")

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

find_package(Threads REQUIRED)

# --- libdatachannel (MPL-2.0) ---------------------------------------------
find_package(LibDataChannel QUIET)
if(NOT TARGET LibDataChannel::LibDataChannel)
  if(NOT VDON_FETCH_LIBDATACHANNEL)
    message(FATAL_ERROR "libdatachannel not found. Install it or enable VDON_FETCH_LIBDATACHANNEL.")
  endif()
  include(FetchContent)
  set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
  set(NO_EXAMPLES ON CACHE BOOL "" FORCE)
  set(NO_TESTS ON CACHE BOOL "" FORCE)
  FetchContent_Declare(libdatachannel
    GIT_REPOSITORY https://github.com/paullouisageneau/libdatachannel.git
    GIT_TAG ${VDON_LIBDATACHANNEL_TAG}
    GIT_SHALLOW TRUE
    GIT_SUBMODULES_RECURSE TRUE)
  FetchContent_MakeAvailable(libdatachannel)
  if(TARGET datachannel-static AND NOT TARGET LibDataChannel::LibDataChannel)
    add_library(LibDataChannel::LibDataChannel ALIAS datachannel-static)
  elseif(TARGET datachannel AND NOT TARGET LibDataChannel::LibDataChannel)
    add_library(LibDataChannel::LibDataChannel ALIAS datachannel)
  endif()
endif()

# --- optional libcurl for hosted TURN list discovery ----------------------
find_package(CURL QUIET)

# --- library ---------------------------------------------------------------
set(VDON_SOURCES
  src/vdon_crypto.c
  src/vdon_sanitize.c
  src/vdon_sdk.c
  src/vdon_sdk_data.c
  src/vdon_signalserver.c
  third_party/cJSON/cJSON.c)

if(VDON_BUILD_SHARED)
  add_library(vdoninja SHARED ${VDON_SOURCES})
  target_compile_definitions(vdoninja PUBLIC VDON_SHARED PRIVATE VDON_BUILDING)
else()
  add_library(vdoninja STATIC ${VDON_SOURCES})
endif()
add_library(vdoninja::vdoninja ALIAS vdoninja)

target_include_directories(vdoninja
  PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include> $<INSTALL_INTERFACE:include>
  PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/third_party/cJSON ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_link_libraries(vdoninja PUBLIC LibDataChannel::LibDataChannel Threads::Threads)
if(CURL_FOUND)
  target_link_libraries(vdoninja PRIVATE CURL::libcurl)
  target_compile_definitions(vdoninja PRIVATE VDON_HAVE_CURL=1)
endif()
if(WIN32)
  target_link_libraries(vdoninja PUBLIC bcrypt)
endif()
if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(vdoninja PRIVATE -Wall -Wextra -Wno-unused-parameter)
endif()

install(TARGETS vdoninja EXPORT vdoninjaTargets
  ARCHIVE DESTINATION lib LIBRARY DESTINATION lib RUNTIME DESTINATION bin)
install(FILES include/vdoninja.h DESTINATION include)

# --- signaling server binary ----------------------------------------------
add_executable(vdoninja-signal src/vdon_signal_main.c)
target_link_libraries(vdoninja-signal PRIVATE vdoninja)

# --- examples --------------------------------------------------------------
if(VDON_BUILD_EXAMPLES)
  foreach(ex chat publish_rtp view_rtp interop)
    add_executable(vdon_${ex} examples/${ex}.c)
    target_link_libraries(vdon_${ex} PRIVATE vdoninja)
  endforeach()
endif()

# --- tests -----------------------------------------------------------------
if(VDON_BUILD_TESTS)
  enable_testing()
  add_executable(vdon_test_vectors tests/test_vectors.c third_party/cJSON/cJSON.c)
  target_include_directories(vdon_test_vectors PRIVATE third_party/cJSON src)
  target_link_libraries(vdon_test_vectors PRIVATE vdoninja)
  target_compile_definitions(vdon_test_vectors PRIVATE VDON_VECTORS_PATH="${CMAKE_CURRENT_SOURCE_DIR}/../spec/vectors.json")
  add_test(NAME vectors COMMAND vdon_test_vectors)

  add_executable(vdon_test_e2e tests/test_e2e.c third_party/cJSON/cJSON.c)
  target_include_directories(vdon_test_e2e PRIVATE third_party/cJSON src)
  target_link_libraries(vdon_test_e2e PRIVATE vdoninja)
  add_test(NAME e2e COMMAND vdon_test_e2e)

  add_executable(vdon_test_review tests/test_review.c)
  target_include_directories(vdon_test_review PRIVATE third_party/cJSON src)
  target_link_libraries(vdon_test_review PRIVATE vdoninja)
  add_test(NAME review_regressions COMMAND vdon_test_review)
endif()
