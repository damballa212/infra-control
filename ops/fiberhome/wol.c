/* Fixed-target WoL sender for the owner's FiberHome; no caller-controlled target. */
#include <arpa/inet.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#ifdef ROUTER_UCLIBC
/* Current glibc headers redirect this call for time64; these options use no time values. */
extern int router_setsockopt(int, int, int, const void *, unsigned int) __asm__("setsockopt");
#define setsockopt router_setsockopt
#endif

#ifdef WOL_TEST
#define DESTINATION "127.0.0.1"
#define PORT 39999
#else
#define DESTINATION "192.168.1.255"
#define PORT 9
#endif

int main(int argc, char **argv) {
    const unsigned char mac[6] = {0x02, 0x00, 0x00, 0x00, 0x00, 0x01};
    unsigned char packet[102];
    memset(packet, 0xff, 6);
    for (int i = 0; i < 16; ++i) memcpy(packet + 6 + i * 6, mac, 6);
    if (argc == 2 && strcmp(argv[1], "--check") == 0) {
        puts("{\"ready\":true,\"bytes\":102,\"packets\":3}");
        return 0;
    }
    if (argc != 1) { fputs("Unsupported arguments\n", stderr); return 2; }
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) { perror("socket"); return 1; }
    int enabled = 1;
    if (setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &enabled, sizeof(enabled)) < 0) {
        perror("SO_BROADCAST"); close(fd); return 1;
    }
#ifndef WOL_TEST
    if (setsockopt(fd, SOL_SOCKET, SO_BINDTODEVICE, "br0", 4) < 0) {
        perror("SO_BINDTODEVICE"); close(fd); return 1;
    }
#endif
    struct sockaddr_in target;
    memset(&target, 0, sizeof(target));
    target.sin_family = AF_INET;
    target.sin_port = htons(PORT);
    if (inet_pton(AF_INET, DESTINATION, &target.sin_addr) != 1) { close(fd); return 1; }
    for (int i = 0; i < 3; ++i) {
        if (sendto(fd, packet, sizeof(packet), 0, (struct sockaddr *)&target, sizeof(target)) != (ssize_t)sizeof(packet)) {
            perror("sendto"); close(fd); return 1;
        }
        if (i < 2) usleep(100000);
    }
    close(fd);
    puts("{\"sent\":true,\"packets\":3,\"mac\":\"02:00:00:00:00:01\",\"destination\":\"192.168.1.255:9\"}");
    return 0;
}
