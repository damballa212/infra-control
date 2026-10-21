/* Mirrors the firmware's o32 PIC entry, using the router's own uClibc. */
    .abicalls
    .set noreorder
    .text
    .globl _start
    .ent _start
_start:
    bal 1f
    nop
1:
    .cpload $ra
    move $ra, $zero
    lw $a0, %got(main)($gp)
    lw $a1, 0($sp)
    addiu $a2, $sp, 4
    move $a3, $zero
    move $t0, $v0
    addiu $sp, $sp, -32
    sw $zero, 16($sp)
    sw $t0, 20($sp)
    sw $sp, 24($sp)
    lw $t9, %call16(__uClibc_main)($gp)
    jalr $t9
    nop
2:  b 2b
    nop
    .end _start
    .section .note.GNU-stack,"",@progbits
