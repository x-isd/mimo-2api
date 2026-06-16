import random

def print_board(board):
    for i, row in enumerate(board):
        print(" " + " | ".join(row))
        if i < 2: print("-----------")

def check_win(b, p):
    for i in range(3):
        if all(b[i][j]==p for j in range(3)) or all(b[j][i]==p for j in range(3)): return True
    return all(b[i][i]==p for i in range(3)) or all(b[i][2-i]==p for i in range(3))

def is_draw(b): return all(b[i][j]!=" " for i in range(3) for j in range(3))

def ai_move(b):
    for p in ["O","X"]:
        for i in range(3):
            for j in range(3):
                if b[i][j]==" ":
                    b[i][j]=p
                    if check_win(b,p): b[i][j]=" "; return (i,j)
                    b[i][j]=" "
    empty=[(i,j) for i in range(3) for j in range(3) if b[i][j]==" "]
    return random.choice(empty) if empty else None

def play():
    b=[[" "]*3 for _ in range(3)]
    print("井字棋: 你(X) vs 电脑(O)\n")
    print_board(b)
    while True:
        while True:
            try:
                r,c=map(int,input("\n你的回合 (行 列): ").split())
                if 0<=r<3 and 0<=c<3 and b[r][c]==" ": break
                print("无效位置!")
            except: print("输入格式: 行 列 (0-2)")
        b[r][c]="X"; print(); print_board(b)
        if check_win(b,"X"): print("\n你赢了!"); break
        if is_draw(b): print("\n平局!"); break
        m=ai_move(b)
        if m: b[m[0]][m[1]]="O"; print(f"\n电脑下了: ({m[0]},{m[1]})"); print(); print_board(b)
        if check_win(b,"O"): print("\n电脑赢了!"); break
        if is_draw(b): print("\n平局!"); break
    print("再玩一次? 重新运行 game.py")

if __name__=="__main__": play()
